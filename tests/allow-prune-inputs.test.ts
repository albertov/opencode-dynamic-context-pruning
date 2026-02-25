import test from "node:test"
import assert from "node:assert/strict"
import { getInvalidConfigKeys, validateConfigTypes, type PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import { buildPrunableToolsList } from "../lib/messages/inject"
import { prune } from "../lib/messages/prune"
import { syncToolCache } from "../lib/state/tool-cache"

function createConfig(
    allowPruneInputs: string[] = [],
    protectedTools: string[] = ["task"],
): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools,
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        protectedFilePatterns: [],
        tools: {
            settings: {
                nudgeEnabled: true,
                nudgeFrequency: 10,
                protectedTools,
                allowPruneInputs,
                contextLimit: 100000,
            },
            distill: {
                permission: "allow",
                showDistillation: false,
            },
            compress: {
                permission: "allow",
                showCompression: false,
            },
            prune: {
                permission: "allow",
            },
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            supersedeWrites: {
                enabled: true,
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

test("config accepts tools.settings.allowPruneInputs key", () => {
    const invalidKeys = getInvalidConfigKeys({
        tools: {
            settings: {
                allowPruneInputs: ["task"],
            },
        },
    })

    assert.deepEqual(invalidKeys, [])
})

test("config validates tools.settings.allowPruneInputs as string[]", () => {
    const validationErrors = validateConfigTypes({
        tools: {
            settings: {
                allowPruneInputs: "task",
            },
        },
    })

    assert.ok(
        validationErrors.some((error) => error.key === "tools.settings.allowPruneInputs"),
        "Expected validation error for tools.settings.allowPruneInputs",
    )
})

test("buildPrunableToolsList includes protected tool when allowPruneInputs contains it", () => {
    const logger = new Logger(false)
    const state = createSessionState()
    const config = createConfig(["task"])

    state.toolIdList.push("call-1")
    state.toolParameters.set("call-1", {
        tool: "task",
        parameters: { prompt: "keep me private" },
        status: "completed",
        turn: 1,
        tokenCount: 42,
    })

    const prunableList = buildPrunableToolsList(state, config, logger)

    assert.match(prunableList, /0: task, .*\(~42 tokens\)/)
})

test("prune redacts inputs for allowPruneInputs tools", () => {
    const logger = new Logger(false)
    const state = createSessionState()
    const config = createConfig(["task"])

    state.prune.tools.set("call-1", 12)

    const messages: WithParts[] = [
        {
            info: {
                id: "assistant-1",
                role: "assistant",
                time: { created: Date.now() },
            } as any,
            parts: [
                {
                    type: "tool",
                    tool: "task",
                    callID: "call-1",
                    state: {
                        status: "completed",
                        input: {
                            prompt: "secret payload",
                            description: "should be pruned",
                        },
                        output: "ok",
                    },
                } as any,
            ],
        },
    ]

    prune(state, logger, config, messages)

    const toolPart = messages[0].parts[0] as any
    assert.equal(toolPart.state.input.prompt, "[Pruned input]")
    assert.equal(toolPart.state.input.description, "[Pruned input]")
})

test("prune keeps output for protected tool in allowPruneInputs", () => {
    const logger = new Logger(false)
    const state = createSessionState()
    const config = createConfig(["task"])

    state.prune.tools.set("call-1", 12)

    const messages: WithParts[] = [
        {
            info: {
                id: "assistant-1",
                role: "assistant",
                time: { created: Date.now() },
            } as any,
            parts: [
                {
                    type: "tool",
                    tool: "task",
                    callID: "call-1",
                    state: {
                        status: "completed",
                        input: {
                            prompt: "secret payload",
                        },
                        output: "must remain visible",
                    },
                } as any,
            ],
        },
    ]

    prune(state, logger, config, messages)

    const toolPart = messages[0].parts[0] as any
    assert.equal(toolPart.state.input.prompt, "[Pruned input]")
    assert.equal(toolPart.state.output, "must remain visible")
})

test("prune still removes output for allowPruneInputs tool when not protected", () => {
    const logger = new Logger(false)
    const state = createSessionState()
    const config = createConfig(["bash"])

    state.prune.tools.set("call-1", 12)

    const messages: WithParts[] = [
        {
            info: {
                id: "assistant-1",
                role: "assistant",
                time: { created: Date.now() },
            } as any,
            parts: [
                {
                    type: "tool",
                    tool: "bash",
                    callID: "call-1",
                    state: {
                        status: "completed",
                        input: {
                            command: "ls",
                        },
                        output: "this should be pruned",
                    },
                } as any,
            ],
        },
    ]

    prune(state, logger, config, messages)

    const toolPart = messages[0].parts[0] as any
    assert.equal(
        toolPart.state.output,
        "[Output removed to save context - information superseded or no longer needed]",
    )
})

test("pruning decision matrix: protectedTools x allowPruneInputs", () => {
    const logger = new Logger(false)
    const outputPlaceholder =
        "[Output removed to save context - information superseded or no longer needed]"

    const cases = [
        {
            protected: false,
            allow: false,
            expectedInputPruned: false,
            expectedOutputPruned: true,
        },
        {
            protected: false,
            allow: true,
            expectedInputPruned: true,
            expectedOutputPruned: true,
        },
        {
            protected: true,
            allow: false,
            expectedInputPruned: false,
            expectedOutputPruned: false,
        },
        {
            protected: true,
            allow: true,
            expectedInputPruned: true,
            expectedOutputPruned: false,
        },
    ]

    for (const [index, testCase] of cases.entries()) {
        const state = createSessionState()
        const toolName = "bash"
        const config = createConfig(
            testCase.allow ? [toolName] : [],
            testCase.protected ? [toolName] : [],
        )

        const callId = `call-${index}`
        state.prune.tools.set(callId, index)

        const messages: WithParts[] = [
            {
                info: {
                    id: `assistant-${index}`,
                    role: "assistant",
                    time: { created: Date.now() },
                } as any,
                parts: [
                    {
                        type: "tool",
                        tool: toolName,
                        callID: callId,
                        state: {
                            status: "completed",
                            input: { command: "ls" },
                            output: "visible output",
                        },
                    } as any,
                ],
            },
        ]

        prune(state, logger, config, messages)

        const toolPart = messages[0].parts[0] as any
        const expectedInput = testCase.expectedInputPruned ? "[Pruned input]" : "ls"
        const expectedOutput = testCase.expectedOutputPruned ? outputPlaceholder : "visible output"
        assert.equal(
            toolPart.state.input.command,
            expectedInput,
            `Input expectation failed for protected=${testCase.protected}, allow=${testCase.allow}`,
        )
        assert.equal(
            toolPart.state.output,
            expectedOutput,
            `Output expectation failed for protected=${testCase.protected}, allow=${testCase.allow}`,
        )
    }
})

test("syncToolCache bypasses protected-tools behavior for allowPruneInputs", () => {
    const logger = new Logger(false)
    const state = createSessionState()
    const config = createConfig(["task"])

    state.currentTurn = 1

    const messages: WithParts[] = [
        {
            info: {
                id: "assistant-1",
                role: "assistant",
                time: { created: Date.now() },
            } as any,
            parts: [
                { type: "step-start" } as any,
                {
                    type: "tool",
                    tool: "task",
                    callID: "call-1",
                    state: {
                        status: "completed",
                        input: { prompt: "run build" },
                        output: "done",
                    },
                } as any,
            ],
        },
    ]

    syncToolCache(state, config, logger, messages)

    assert.equal(state.nudgeCounter, 1)
    const entry = state.toolParameters.get("call-1")
    assert.equal(typeof entry?.tokenCount, "number")
})
