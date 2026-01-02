/**
 * Token Usage Tracker Extension for SillyTavern
 * Tracks input/output token usage across messages with time-based aggregation
 *
 * Uses SillyTavern's native tokenizer system for accurate counting:
 * - getTokenCountAsync() for async token counting
 * - getTextTokens() for getting actual token IDs when available
 * - Respects user's tokenizer settings (BEST_MATCH, model-specific, etc.)
 */

import { eventSource, event_types, main_api, streamingProcessor, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, getTextTokens, getFriendlyTokenizerName, tokenizers } from '../../../tokenizers.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getChatCompletionModel, oai_settings } from '../../../openai.js';
import { textgenerationwebui_settings as textgen_settings } from '../../../textgen-settings.js';

const extensionName = 'token-usage-tracker';

const defaultSettings = {
    showInTopBar: true,
    modelColors: {}, // { "gpt-4o": "#6366f1", "claude-3-opus": "#8b5cf6", ... }
    // Prices per 1M tokens: { "gpt-4o": { in: 2.5, out: 10 }, ... }
    modelPrices: {},
    // Accumulated usage data
    usage: {
        session: { input: 0, output: 0, total: 0, messageCount: 0, startTime: null },
        allTime: { input: 0, output: 0, total: 0, messageCount: 0 },
        // Time-based buckets: { "2025-01-15": { input: X, output: Y, total: Z, models: { "gpt-4o": 500, ... } }, ... }
        byDay: {},
        byHour: {},    // "2025-01-15T14": { ... }
        byWeek: {},    // "2025-W03": { ... }
        byMonth: {},   // "2025-01": { ... }
        // Per-chat usage: { "chatId": { input: X, output: Y, ... }, ... }
        byChat: {},
        // Per-model usage: { "gpt-4o": { input: X, output: Y, total: Z, messageCount: N }, ... }
        byModel: {},
    },
};

/**
 * Load extension settings, merging with defaults
 */
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    // Deep merge defaults for any missing keys
    const settings = extension_settings[extensionName];
    if (!settings.modelColors) settings.modelColors = {};
    if (!settings.usage) settings.usage = structuredClone(defaultSettings.usage);
    if (!settings.usage.session) settings.usage.session = structuredClone(defaultSettings.usage.session);
    if (!settings.usage.allTime) settings.usage.allTime = structuredClone(defaultSettings.usage.allTime);
    if (!settings.usage.byDay) settings.usage.byDay = {};
    if (!settings.usage.byHour) settings.usage.byHour = {};
    if (!settings.usage.byWeek) settings.usage.byWeek = {};
    if (!settings.usage.byMonth) settings.usage.byMonth = {};
    if (!settings.usage.byChat) settings.usage.byChat = {};
    if (!settings.usage.byModel) settings.usage.byModel = {};

    // Initialize modelPrices
    if (!settings.modelPrices) settings.modelPrices = {};

    // Migration: Convert byDay.models from numeric format to object format
    // Old: models[modelId] = totalTokens (number)
    // New: models[modelId] = { input, output, total }
    for (const dayData of Object.values(settings.usage.byDay)) {
        if (dayData.models) {
            for (const [modelId, value] of Object.entries(dayData.models)) {
                if (typeof value === 'number') {
                    // Migrate: estimate input/output using day's ratio
                    const ratio = dayData.total ? value / dayData.total : 0;
                    dayData.models[modelId] = {
                        input: Math.round((dayData.input || 0) * ratio),
                        output: Math.round((dayData.output || 0) * ratio),
                        total: value
                    };
                }
            }
        }
    }

    // Initialize session start time
    if (!settings.usage.session.startTime) {
        settings.usage.session.startTime = new Date().toISOString();
    }

    return settings;
}

/**
 * Save settings with debounce
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Get current settings
 */
function getSettings() {
    return extension_settings[extensionName];
}

/**
 * Get the current day key (YYYY-MM-DD)
 */
function getDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Get the current hour key (YYYY-MM-DDTHH)
 */
function getHourKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}`;
}

/**
 * Get the current week key (YYYY-WNN)
 */
function getWeekKey(date = new Date()) {
    const year = date.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Get the current month key (YYYY-MM)
 */
function getMonthKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * Count tokens using SillyTavern's native tokenizer
 * Uses getTextTokens for accurate IDs when available, falls back to getTokenCountAsync
 * @param {string} text - Text to tokenize
 * @returns {Promise<number>} Token count
 */
async function countTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    try {
        // Get the current tokenizer based on user settings and API
        const { tokenizerId } = getFriendlyTokenizerName(main_api);

        // Try to get actual token IDs first (more accurate)
        const tokenizerType = main_api === 'openai' ? tokenizers.OPENAI : tokenizerId;
        const tokenIds = getTextTokens(tokenizerType, text);

        if (Array.isArray(tokenIds) && tokenIds.length > 0) {
            return tokenIds.length;
        }

        // Fall back to async count (uses caching)
        return await getTokenCountAsync(text);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting tokens:', error);
        // Ultimate fallback: character-based estimate
        return Math.ceil(text.length / 3.35);
    }
}

/**
 * Get the current model ID based on the active API
 * @returns {string} Model identifier
 */
function getCurrentModelId() {
    try {
        if (main_api === 'openai') {
            const model = getChatCompletionModel();
            return model || oai_settings?.custom_model || 'unknown-openai';
        }
        if (main_api === 'textgenerationwebui') {
            return textgen_settings?.model || 'unknown-textgen';
        }
        if (main_api === 'novel') {
            return 'novelai';
        }
        if (main_api === 'kobold') {
            return 'kobold';
        }
        return main_api || 'unknown';
    } catch (e) {
        console.warn('[Token Usage Tracker] Error getting model ID:', e);
        return 'unknown';
    }
}

/**
 * Record token usage into all relevant buckets
 * @param {number} inputTokens - Tokens in the user message
 * @param {number} outputTokens - Tokens in the AI response
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 */
function recordUsage(inputTokens, outputTokens, chatId = null, modelId = null) {
    const settings = getSettings();
    const usage = settings.usage;
    const now = new Date();
    const totalTokens = inputTokens + outputTokens;

    const addTokens = (bucket) => {
        bucket.input = (bucket.input || 0) + inputTokens;
        bucket.output = (bucket.output || 0) + outputTokens;
        bucket.total = (bucket.total || 0) + totalTokens;
        bucket.messageCount = (bucket.messageCount || 0) + 1;
    };

    // Session
    addTokens(usage.session);

    // All-time
    addTokens(usage.allTime);

    // By day
    const dayKey = getDayKey(now);
    if (!usage.byDay[dayKey]) usage.byDay[dayKey] = { input: 0, output: 0, total: 0, messageCount: 0, models: {} };
    addTokens(usage.byDay[dayKey]);

    // Track model within day for stacked chart (with input/output breakdown for cost calculation)
    if (modelId) {
        if (!usage.byDay[dayKey].models) usage.byDay[dayKey].models = {};
        if (!usage.byDay[dayKey].models[modelId]) {
            usage.byDay[dayKey].models[modelId] = { input: 0, output: 0, total: 0 };
        }
        const modelData = usage.byDay[dayKey].models[modelId];
        modelData.input += inputTokens;
        modelData.output += outputTokens;
        modelData.total += totalTokens;
    }

    // By hour
    const hourKey = getHourKey(now);
    if (!usage.byHour[hourKey]) usage.byHour[hourKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byHour[hourKey]);

    // By week
    const weekKey = getWeekKey(now);
    if (!usage.byWeek[weekKey]) usage.byWeek[weekKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byWeek[weekKey]);

    // By month
    const monthKey = getMonthKey(now);
    if (!usage.byMonth[monthKey]) usage.byMonth[monthKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byMonth[monthKey]);

    // By chat
    if (chatId) {
        if (!usage.byChat[chatId]) usage.byChat[chatId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byChat[chatId]);
    }

    // By model (aggregate)
    if (modelId) {
        if (!usage.byModel[modelId]) usage.byModel[modelId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byModel[modelId]);
    }

    saveSettings();

    // Emit custom event for UI updates
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    console.log(`[Token Usage Tracker] Recorded: +${inputTokens} input, +${outputTokens} output, model: ${modelId || 'unknown'} (using ${getFriendlyTokenizerName(main_api).tokenizerName})`);
}

/**
 * Reset session usage
 */
function resetSession() {
    const settings = getSettings();
    settings.usage.session = {
        input: 0,
        output: 0,
        total: 0,
        messageCount: 0,
        startTime: new Date().toISOString(),
    };
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] Session reset');
}

/**
 * Reset all usage data
 */
function resetAllUsage() {
    const settings = getSettings();
    settings.usage = structuredClone(defaultSettings.usage);
    settings.usage.session.startTime = new Date().toISOString();
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] All usage data reset');
}

/**
 * Get comprehensive usage statistics
 * @returns {Object} Usage statistics object
 */
function getUsageStats() {
    const settings = getSettings();
    const usage = settings.usage;
    const now = new Date();

    // Get current tokenizer info for display
    let tokenizerInfo = { tokenizerName: 'Unknown' };
    try {
        tokenizerInfo = getFriendlyTokenizerName(main_api);
    } catch (e) {
        // Ignore if not available yet
    }

    return {
        session: { ...usage.session },
        allTime: { ...usage.allTime },
        today: usage.byDay[getDayKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0, models: {} },
        thisHour: usage.byHour[getHourKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisWeek: usage.byWeek[getWeekKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisMonth: usage.byMonth[getMonthKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        currentChat: null, // Will be populated if context available
        // Metadata
        tokenizer: tokenizerInfo.tokenizerName,
        // Raw data for advanced aggregation
        byDay: { ...usage.byDay },
        byHour: { ...usage.byHour },
        byWeek: { ...usage.byWeek },
        byMonth: { ...usage.byMonth },
        byChat: { ...usage.byChat },
        byModel: { ...usage.byModel },
    };
}

/**
 * Get usage for a specific time range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Object} Aggregated usage for the range
 */
function getUsageForRange(startDate, endDate) {
    const settings = getSettings();
    const usage = settings.usage;

    const result = { input: 0, output: 0, total: 0, messageCount: 0 };

    for (const [day, data] of Object.entries(usage.byDay)) {
        if (day >= startDate && day <= endDate) {
            result.input += data.input || 0;
            result.output += data.output || 0;
            result.total += data.total || 0;
            result.messageCount += data.messageCount || 0;
        }
    }

    return result;
}

/**
 * Get usage for a specific chat
 * @param {string} chatId - Chat ID
 * @returns {Object} Usage for the chat
 */
function getChatUsage(chatId) {
    const settings = getSettings();
    return settings.usage.byChat[chatId] || { input: 0, output: 0, total: 0, messageCount: 0 };
}


/** @type {Promise<number>|null} Promise that resolves to input token count - started early, awaited later */
let pendingInputTokensPromise = null;
let pendingModelId = null;
// For 'continue' type generations, track the pre-continue token count so we can compute the delta
let preContinueTokenCount = 0;

/**
 * Count input tokens from the full prompt context (async helper)
 * @param {object} generate_data - The generation data containing the full prompt
 * @returns {Promise<number>} Total input token count
 */
async function countInputTokens(generate_data) {
    let inputTokens = 0;

    if (generate_data.prompt) {
        // For text completion APIs (kobold, novel, textgen) - prompt is a string
        if (typeof generate_data.prompt === 'string') {
            inputTokens = await countTokens(generate_data.prompt);
        }
        // For chat completion APIs (OpenAI) - prompt is an array of messages
        else if (Array.isArray(generate_data.prompt)) {
            for (const message of generate_data.prompt) {
                if (message.content) {
                    // Content can be a string or an array of content parts (for multimodal)
                    if (typeof message.content === 'string') {
                        inputTokens += await countTokens(message.content);
                    } else if (Array.isArray(message.content)) {
                        // Handle multimodal content (text + images)
                        for (const part of message.content) {
                            if (part.type === 'text' && part.text) {
                                inputTokens += await countTokens(part.text);
                            }
                            if (part.type === 'image_url' || part.type === 'image') {
                                // Estimate image tokens since we can't be precise without knowing the exact model arithmetic
                                // 765 tokens is the cost of a 1024x1024 image in OpenAI high detail mode
                                inputTokens += 765;
                            }
                        }
                    }
                }
                // Count role tokens (~1 token per role)
                if (message.role) {
                    inputTokens += 1;
                }
                // Count name field tokens (used in function calls, tool results, etc.)
                if (message.name) {
                    inputTokens += await countTokens(message.name);
                }
                // Count tool_calls tokens (Standard OpenAI)
                if (Array.isArray(message.tool_calls)) {
                    for (const toolCall of message.tool_calls) {
                        if (toolCall.function) {
                            if (toolCall.function.name) {
                                inputTokens += await countTokens(toolCall.function.name);
                            }
                            if (toolCall.function.arguments) {
                                inputTokens += await countTokens(toolCall.function.arguments);
                            }
                        }
                    }
                }
                // Count invocations tokens (SillyTavern internal)
                if (Array.isArray(message.invocations)) {
                    for (const invocation of message.invocations) {
                        if (invocation.function) {
                            if (invocation.function.name) {
                                inputTokens += await countTokens(invocation.function.name);
                            }
                            if (invocation.function.arguments) {
                                inputTokens += await countTokens(invocation.function.arguments);
                            }
                        }
                    }
                }
                // Count deprecated function_call tokens
                if (message.function_call) {
                    if (message.function_call.name) {
                        inputTokens += await countTokens(message.function_call.name);
                    }
                    if (message.function_call.arguments) {
                        inputTokens += await countTokens(message.function_call.arguments);
                    }
                }
            }
            // Add overhead for message formatting (rough estimate: ~3 tokens per message boundary)
            inputTokens += generate_data.prompt.length * 3;
        }
    }

    return inputTokens;
}

/**
 * Handle GENERATE_AFTER_DATA event - start counting input tokens (non-blocking)
 * @param {object} generate_data - The generation data containing the full prompt
 * @param {boolean} dryRun - Whether this is a dry run (token counting only)
 */
function handleGenerateAfterData(generate_data, dryRun) {
    // Don't count dry runs - they're just for token estimation, not actual API calls
    if (dryRun) return;

    // Capture model ID synchronously (fast)
    pendingModelId = getCurrentModelId();

    // Start token counting but DON'T await - let it run in parallel with the API request
    pendingInputTokensPromise = countInputTokens(generate_data)
        .then(count => {
            console.log(`[Token Usage Tracker] Input tokens (full context): ${count}, model: ${pendingModelId}`);
            return count;
        })
        .catch(error => {
            console.error('[Token Usage Tracker] Error counting input tokens:', error);
            return 0;
        });
}

/**
 * Handle GENERATION_STARTED event - capture pre-continue state
 * This fires before the API call, allowing us to snapshot the current message state
 * for 'continue' type generations so we can calculate the delta later.
 * @param {string} type - Generation type: 'normal', 'continue', 'swipe', 'regenerate', etc.
 * @param {object} params - Generation parameters
 * @param {boolean} isDryRun - Whether this is a dry run
 */
async function handleGenerationStarted(type, params, isDryRun) {
    if (isDryRun) return;

    // Reset pre-continue state
    preContinueTokenCount = 0;

    // For continue type, capture the current message's token count
    if (type === 'continue') {
        try {
            const context = getContext();
            const lastMessage = context.chat[context.chat.length - 1];

            if (lastMessage) {
                // Use existing token count if available
                if (lastMessage.extra?.token_count && typeof lastMessage.extra.token_count === 'number') {
                    preContinueTokenCount = lastMessage.extra.token_count;
                } else {
                    // Calculate it ourselves
                    let tokens = await countTokens(lastMessage.mes || '');
                    if (lastMessage.extra?.reasoning) {
                        tokens += await countTokens(lastMessage.extra.reasoning);
                    }
                    preContinueTokenCount = tokens;
                }
                console.log(`[Token Usage Tracker] Pre-continue token count: ${preContinueTokenCount}`);
            }
        } catch (error) {
            console.error('[Token Usage Tracker] Error capturing pre-continue state:', error);
            preContinueTokenCount = 0;
        }
    }
}

/**
 * Handle message received event - count output tokens and record
 * Uses SillyTavern's pre-calculated token_count when available (includes reasoning)
 * Falls back to manual counting if not available
 *
 * @param {number} messageIndex - Index of the message in the chat array
 * @param {string} type - Type of message event: 'normal', 'swipe', 'continue', 'command', 'first_message', 'extension', etc.
 */
async function handleMessageReceived(messageIndex, type) {
    // Filter out events that don't correspond to actual API calls
    // These events are emitted for messages created without calling the API
    const nonApiTypes = ['command', 'first_message'];
    if (nonApiTypes.includes(type)) {
        console.log(`[Token Usage Tracker] Skipping non-API message type: ${type}`);
        return;
    }

    // If there's no pending token counting promise, this likely isn't a real API response
    // (e.g., could be a late-firing event after chat load)
    if (!pendingInputTokensPromise) {
        console.log(`[Token Usage Tracker] Skipping message with no pending token count (type: ${type || 'unknown'})`);
        return;
    }

    try {
        const context = getContext();
        const message = context.chat[messageIndex];

        if (!message || !message.mes) return;

        let outputTokens;

        // Use SillyTavern's pre-calculated token count if available
        // This already includes reasoning tokens when power_user.message_token_count_enabled is true
        if (message.extra?.token_count && typeof message.extra.token_count === 'number') {
            outputTokens = message.extra.token_count;
            console.log(`[Token Usage Tracker] Using pre-calculated token count: ${outputTokens}`);
        } else {
            // Fall back to manual counting
            outputTokens = await countTokens(message.mes);

            // Also count reasoning/thinking tokens (from Claude thinking, OpenAI o1, etc.)
            if (message.extra?.reasoning) {
                const reasoningTokens = await countTokens(message.extra.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} reasoning tokens`);
            }
            console.log(`[Token Usage Tracker] Manually counted tokens: ${outputTokens}`);
        }

        // For 'continue' type, we only want the newly generated tokens, not the full message
        // Subtract the pre-continue token count to get just the delta
        if (type === 'continue' && preContinueTokenCount > 0) {
            const originalOutputTokens = outputTokens;
            outputTokens = Math.max(0, outputTokens - preContinueTokenCount);
            console.log(`[Token Usage Tracker] Continue type: ${originalOutputTokens} total - ${preContinueTokenCount} pre-continue = ${outputTokens} new tokens`);
        }

        // Reset pre-continue state
        const savedPreContinueCount = preContinueTokenCount;
        preContinueTokenCount = 0;

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;

        // Get current chat ID if available
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId);

        console.log(`[Token Usage Tracker] Recorded exchange: ${inputTokens} in, ${outputTokens} out, model: ${modelId || 'unknown'}${savedPreContinueCount > 0 ? ' (continue delta)' : ''}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting output tokens:', error);
    }
}

/**
 * Handle generation stopped event - count tokens for cancelled/stopped generations
 * This ensures that input tokens (which were sent to the API) are still counted,
 * along with any partial output tokens that were generated before stopping.
 */
async function handleGenerationStopped() {
    // If there's no pending token counting promise, nothing to record
    if (!pendingInputTokensPromise) return;

    try {
        let outputTokens = 0;

        // Try to get partial output from the streaming processor
        if (streamingProcessor) {
            // Count main response text
            if (streamingProcessor.result) {
                outputTokens = await countTokens(streamingProcessor.result);
                console.log(`[Token Usage Tracker] Partial output from stopped generation: ${outputTokens} tokens`);
            }

            // Also count any reasoning tokens that were generated
            if (streamingProcessor.reasoningHandler?.reasoning) {
                const reasoningTokens = await countTokens(streamingProcessor.reasoningHandler.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} partial reasoning tokens`);
            }
        }

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;
        preContinueTokenCount = 0; // Reset continue state too

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        // Record the usage - input tokens were sent even if generation was stopped
        recordUsage(inputTokens, outputTokens, chatId, modelId);

        console.log(`[Token Usage Tracker] Recorded stopped generation: ${inputTokens} in, ${outputTokens} out (partial), model: ${modelId || 'unknown'}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling stopped generation:', error);
        // Reset pending tokens even on error to prevent double counting
        pendingInputTokensPromise = null;
        preContinueTokenCount = 0;
    }
}

/**
 * Handle chat changed event
 */
function handleChatChanged(chatId) {
    // Reset pending tokens when chat changes to prevent cross-chat counting
    pendingInputTokensPromise = null;
    pendingModelId = null;
    preContinueTokenCount = 0;
    console.log(`[Token Usage Tracker] Chat changed to: ${chatId}`);
    eventSource.emit('tokenUsageUpdated', getUsageStats());
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenusage',
        callback: async () => {
            const stats = getUsageStats();
            const output = [
                `Tokenizer: ${stats.tokenizer}`,
                `Session: ${stats.session.total} tokens (${stats.session.input} in, ${stats.session.output} out)`,
                `Today: ${stats.today.total} tokens`,
                `This Week: ${stats.thisWeek.total} tokens`,
                `This Month: ${stats.thisMonth.total} tokens`,
                `All Time: ${stats.allTime.total} tokens`,
            ].join('\n');
            return output;
        },
        returns: 'Token usage statistics',
        helpString: 'Displays current token usage statistics across different time periods.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenreset',
        callback: async (args) => {
            const scope = String(args || '').trim() || 'session';
            if (scope === 'all') {
                resetAllUsage();
                return 'All token usage data has been reset.';
            } else {
                resetSession();
                return 'Session token usage has been reset.';
            }
        },
        returns: 'Confirmation message',
        helpString: 'Resets token usage. Use /tokenreset for session only, or /tokenreset all for all data.',
    }));
}

/**
 * Public API exposed for frontend/UI components
 */
window['TokenUsageTracker'] = {
    getStats: getUsageStats,
    getUsageForRange,
    getChatUsage,
    resetSession,
    resetAllUsage,
    recordUsage,
    countTokens, // Expose the token counting function
    // Subscribe to updates
    onUpdate: (callback) => {
        eventSource.on('tokenUsageUpdated', callback);
    },
    // Unsubscribe from updates
    offUpdate: (callback) => {
        eventSource.removeListener('tokenUsageUpdated', callback);
    },
};

/**
 * Format token count with K/M suffix
 */
function formatTokens(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toString();
}

/**
 * Format number with commas
 */
function formatNumberFull(num) {
    return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Generate a random color using HSL for guaranteed distinctness
 * Colors are persisted once assigned to maintain consistency
 * @param {string} modelId - Model identifier
 * @returns {string} Hex color code
 */
function getModelColor(modelId) {
    const settings = getSettings();

    // Return persisted color if exists
    if (settings.modelColors[modelId]) {
        return settings.modelColors[modelId];
    }

    // Get all existing assigned colors to avoid duplicates
    const existingColors = Object.values(settings.modelColors);

    // Generate a random color that's distinct from existing ones
    let newColor;
    let attempts = 0;
    do {
        // Random hue (0-360), high saturation (60-80%), medium lightness (45-65%)
        const hue = Math.floor(Math.random() * 360);
        const sat = 60 + Math.floor(Math.random() * 20);
        const light = 45 + Math.floor(Math.random() * 20);
        newColor = hslToHex(hue, sat, light);
        attempts++;
    } while (attempts < 50 && isTooSimilar(newColor, existingColors));

    // Persist the new color
    settings.modelColors[modelId] = newColor;
    saveSettings();

    return newColor;
}

/**
 * Convert HSL to hex color
 */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Check if a color is too similar to any existing colors
 */
function isTooSimilar(newColor, existingColors) {
    for (const existing of existingColors) {
        if (colorDistance(newColor, existing) < 50) {
            return true;
        }
    }
    return false;
}

/**
 * Calculate color distance (simple RGB euclidean)
 */
function colorDistance(c1, c2) {
    const r1 = parseInt(c1.slice(1, 3), 16);
    const g1 = parseInt(c1.slice(3, 5), 16);
    const b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16);
    const g2 = parseInt(c2.slice(3, 5), 16);
    const b2 = parseInt(c2.slice(5, 7), 16);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Set color for a model
 * @param {string} modelId - Model identifier
 * @param {string} color - Hex color code
 */
function setModelColor(modelId, color) {
    const settings = getSettings();
    settings.modelColors[modelId] = color;
    saveSettings();
}

/**
 * Get price settings for a model
 * @param {string} modelId
 * @returns {{in: number, out: number}} Price per 1M tokens
 */
function getModelPrice(modelId) {
    const settings = getSettings();
    return settings.modelPrices[modelId] || { in: 0, out: 0 };
}

/**
 * Set price settings for a model
 * @param {string} modelId
 * @param {number} priceIn - Price per 1M input tokens
 * @param {number} priceOut - Price per 1M output tokens
 */
function setModelPrice(modelId, priceIn, priceOut) {
    const settings = getSettings();
    settings.modelPrices[modelId] = {
        in: parseFloat(priceIn) || 0,
        out: parseFloat(priceOut) || 0
    };
    saveSettings();
}

/**
 * Calculate cost for a given token usage and model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelId
 * @returns {number} Cost in dollars
 */
function calculateCost(inputTokens, outputTokens, modelId) {
    const prices = getModelPrice(modelId);
    if (!prices.in && !prices.out) return 0;

    const inputCost = (inputTokens / 1000000) * prices.in;
    const outputCost = (outputTokens / 1000000) * prices.out;
    return inputCost + outputCost;
}

/**
 * Calculate all-time cost using the byModel aggregation which has precise input/output counts
 */
function calculateAllTimeCost() {
    const settings = getSettings();
    const byModel = settings.usage.byModel;
    let totalCost = 0;

    for (const [modelId, data] of Object.entries(byModel)) {
        totalCost += calculateCost(data.input, data.output, modelId);
    }
    return totalCost;
}

// Chart state
let currentChartRange = 30;
let chartData = [];
let tooltip = null;

// Chart colors - adapted for dark theme
const CHART_COLORS = {
    bar: 'var(--SmartThemeBorderColor)',
    text: 'var(--SmartThemeBodyColor)',
    grid: 'var(--SmartThemeBorderColor)',
    cursor: 'var(--SmartThemeBodyColor)'
};

const SVG_NS = "http://www.w3.org/2000/svg";

function createSVGElement(type, attrs = {}) {
    const el = document.createElementNS(SVG_NS, type);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}

/**
 * Get chart data from real usage stats
 */
function getChartData(days) {
    const stats = getUsageStats();
    const byDay = stats.byDay || {};
    const data = [];
    const today = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dayKey = getDayKey(date);
        const dayData = byDay[dayKey] || { total: 0, input: 0, output: 0, models: {} };

        data.push({
            date: date,
            dayKey: dayKey,
            usage: dayData.total || 0,
            input: dayData.input || 0,
            output: dayData.output || 0,
            models: dayData.models || {},
            displayDate: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date),
            fullDate: new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date)
        });
    }
    return data;
}

/**
 * Render the bar chart
 */
function renderChart() {
    const container = document.getElementById('token-usage-chart');
    if (!container) return;

    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (width === 0 || height === 0) return;
    if (chartData.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.5); padding: 40px;">No usage data yet</div>';
        return;
    }

    const margin = { top: 10, right: 10, bottom: 25, left: 45 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const svg = createSVGElement('svg', {
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
        style: 'display: block; max-width: 100%;'
    });


    const cursorGroup = createSVGElement('g', { class: 'cursors' });
    const gridGroup = createSVGElement('g', { class: 'grid' });
    const barGroup = createSVGElement('g', { class: 'bars' });
    const textGroup = createSVGElement('g', { class: 'labels' });

    svg.appendChild(cursorGroup);
    svg.appendChild(gridGroup);
    svg.appendChild(barGroup);
    svg.appendChild(textGroup);

    // Y Scale
    const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
    const roughStep = maxUsage / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
    let step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

    if (step / magnitude < 1.5) step = 1 * magnitude;
    else if (step / magnitude < 3) step = 2.5 * magnitude;
    else if (step / magnitude < 7) step = 5 * magnitude;
    else step = 10 * magnitude;

    let niceMax = Math.ceil(maxUsage / step) * step;
    if (niceMax === 0) niceMax = 5000;

    const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;

    // Grid and Y axis
    for (let val = 0; val <= niceMax; val += step) {
        const y = margin.top + yScale(val);

        const line = createSVGElement('line', {
            x1: margin.left,
            y1: y,
            x2: width - margin.right,
            y2: y,
            stroke: CHART_COLORS.grid,
            'stroke-width': '1',
            'stroke-dasharray': '4 4'
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            fill: CHART_COLORS.text,
            'font-size': '10',
            'font-family': 'ui-sans-serif, system-ui, sans-serif'
        });
        text.textContent = formatTokens(val);
        textGroup.appendChild(text);
    }

    // Bars
    const totalBarWidth = chartWidth / chartData.length;
    let barWidth = totalBarWidth * 0.8;
    if (barWidth > 40) barWidth = 40;
    const actualGap = totalBarWidth - barWidth;
    const labelInterval = currentChartRange === 90 ? 7 : currentChartRange === 30 ? 3 : 1;

    chartData.forEach((d, i) => {
        const slotX = margin.left + (i * totalBarWidth);
        const barX = slotX + (actualGap / 2);
        const barH = (d.usage / niceMax) * chartHeight;
        const barY = margin.top + (chartHeight - barH);

        // Hover area
        const cursor = createSVGElement('rect', {
            x: slotX,
            y: margin.top,
            width: totalBarWidth,
            height: chartHeight,
            fill: 'transparent',
            opacity: '0.1',
            class: 'cursor-rect',
            style: 'cursor: pointer;'
        });

        cursor.addEventListener('mouseenter', () => {
            cursor.setAttribute('fill', CHART_COLORS.cursor);
            showTooltip(d);
        });
        cursor.addEventListener('mousemove', (e) => {
            moveTooltip(e);
        });
        cursor.addEventListener('mouseleave', () => {
            cursor.setAttribute('fill', 'transparent');
            hideTooltip();
        });
        cursorGroup.appendChild(cursor);

        // Bar rendering - fill segments with model colors
        const r = Math.min(3, barWidth / 4);
        const h = Math.max(0, barH);
        const w = barWidth;

        // Build the outer bar path (with rounded top corners)
        let outerPathD;
        if (h < r * 2) {
            outerPathD = `M ${barX},${barY + h} v-${h} h${w} v${h} z`;
        } else {
            outerPathD = `M ${barX},${barY + h} v-${h - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`;
        }

        // Draw filled segments for each model
        if (d.models && Object.keys(d.models).length > 0 && d.usage > 0) {
            // Extract total from new object format or use number directly for legacy
            const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
            const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(b[1]) - getTokens(a[1])); // Sort by usage desc

            let cumulativeY = barY + h; // Start from bottom

            for (const [modelId, modelData] of modelEntries) {
                const tokens = getTokens(modelData);
                const segmentHeight = (tokens / d.usage) * h;
                const segmentY = cumulativeY - segmentHeight;

                // Create path for this segment with rounded corners for top segment
                let segmentPath;
                const isBottom = cumulativeY === barY + h;
                const isTop = segmentY <= barY + 0.01; // Small epsilon for float comparison

                if (segmentHeight < r * 2) {
                    // Too small for rounded corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                } else if (isTop && isBottom) {
                    // Only segment - round top corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else if (isTop) {
                    // Top segment - round top corners only
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else {
                    // Bottom or middle segment - no rounding
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                }

                const color = getModelColor(modelId);
                const segment = createSVGElement('path', {
                    d: segmentPath,
                    fill: color,
                    opacity: '1',
                    'shape-rendering': 'geometricPrecision',
                    'pointer-events': 'none'
                });
                barGroup.appendChild(segment);

                cumulativeY = segmentY;
            }
        }

        // Draw outer bar border (on top of segments)
        const outerPath = createSVGElement('path', {
            d: outerPathD,
            fill: 'none',
            stroke: CHART_COLORS.bar,
            'stroke-width': '1.5',
            'shape-rendering': 'geometricPrecision',
            'pointer-events': 'none'
        });
        barGroup.appendChild(outerPath);


        // X labels
        if (i % labelInterval === 0) {
            const label = createSVGElement('text', {
                x: barX + barWidth / 2,
                y: height - 5,
                'text-anchor': 'middle',
                fill: CHART_COLORS.text,
                opacity: '0.6',
                'font-size': '10',
                'font-family': 'ui-sans-serif, system-ui, sans-serif'
            });
            label.textContent = d.displayDate;
            textGroup.appendChild(label);
        }
    });

    container.appendChild(svg);
}

function showTooltip(d) {
    if (!tooltip) return;

    // Build model breakdown HTML
    let modelBreakdown = '';
    if (d.models && Object.keys(d.models).length > 0) {
        // Extract total from new object format or use number directly for legacy
        const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
        const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(a[1]) - getTokens(b[1])); // Sort ascending (smallest first, like graph bottom-up)
        modelBreakdown = '<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.2);">';
        const displayEntries = modelEntries.slice(-8); // Show last 8 (the largest)
        for (const [model, modelData] of displayEntries) {
            const tokens = getTokens(modelData);
            const percent = d.usage > 0 ? Math.round((tokens / d.usage) * 100) : 0;
            const shortName = model.length > 25 ? model.substring(0, 22) + '...' : model;
            const color = getModelColor(model);
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                </div>
                <span style="flex-shrink: 0;">${formatTokens(tokens)} (${percent}%)</span>
            </div>`;
        }
        if (modelEntries.length > 8) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3);">+${modelEntries.length - 8} more</div>`;
        }
        modelBreakdown += '</div>';
    }

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="color: var(--SmartThemeBodyColor);">${formatNumberFull(d.usage)} tokens</div>
        <div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.6;">${formatNumberFull(d.input)} in / ${formatNumberFull(d.output)} out</div>
        ${modelBreakdown}
    `;
    tooltip.style.display = 'block';
}

function moveTooltip(e) {
    if (!tooltip) return;

    const tooltipWidth = tooltip.offsetWidth || 150;
    const tooltipHeight = tooltip.offsetHeight || 60;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = e.clientX + 15;
    let y = e.clientY - 10;

    // Keep tooltip within viewport
    if (x + tooltipWidth > viewportWidth - 10) {
        x = e.clientX - tooltipWidth - 15;
    }
    if (y + tooltipHeight > viewportHeight - 10) {
        y = viewportHeight - tooltipHeight - 10;
    }
    if (y < 10) {
        y = 10;
    }
    if (x < 10) {
        x = 10;
    }

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}


function updateChartRange(range) {
    currentChartRange = range;
    chartData = getChartData(range);
    renderChart();

    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        const val = parseInt(btn.getAttribute('data-value'));
        if (val === range) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

/**
 * Update the stats display in the UI
 */
function updateUIStats() {
    const stats = getUsageStats();
    const now = new Date();

    // Today header
    $('#token-usage-today-total').text(formatTokens(stats.today.total));
    $('#token-usage-today-in').text(formatTokens(stats.today.input || 0));
    $('#token-usage-today-out').text(formatTokens(stats.today.output || 0));

    // Stats grid
    $('#token-usage-week-total').text(formatTokens(stats.thisWeek.total));
    $('#token-usage-month-total').text(formatTokens(stats.thisMonth.total));
    $('#token-usage-alltime-total').text(formatTokens(stats.allTime.total));

    // Cost calculations
    const allTimeCost = calculateAllTimeCost();

    if (allTimeCost > 0) {
        $('#token-usage-alltime-cost').text(`$${allTimeCost.toFixed(2)}`);
    } else {
        $('#token-usage-alltime-cost').text('$0.00');
    }

    // For Week/Month: We iterate all `byDay` keys and match those that belong to current week/month
    const currentWeekKey = getWeekKey(now);
    const currentMonthKey = getMonthKey(now);
    const todayKey = getDayKey(now);

    let weekCost = 0;
    let monthCost = 0;
    let todayCost = 0;

    const settings = getSettings();
    for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
        // Parse dayKey (YYYY-MM-DD) as local date, not UTC
        // new Date("2026-01-01") interprets as UTC, which shifts timezone
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        // Week check
        if (getWeekKey(date) === currentWeekKey) {
            // Calculate cost for this day using per-model input/output breakdown
            if (data.models) {
                for (const [mid, modelData] of Object.entries(data.models)) {
                    // modelData is now { input, output, total } (or number for legacy data)
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    const cost = calculateCost(mInput, mOutput, mid);
                    weekCost += cost;
                    if (dayKey === todayKey) {
                        todayCost += cost;
                    }
                }
            }
        }
        // Month check
        if (getMonthKey(date) === currentMonthKey) {
             if (data.models) {
                 for (const [mid, modelData] of Object.entries(data.models)) {
                     const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                     const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                     monthCost += calculateCost(mInput, mOutput, mid);
                 }
            }
        }
    }

    $('#token-usage-week-cost').text(`$${weekCost.toFixed(2)}`);
    $('#token-usage-month-cost').text(`$${monthCost.toFixed(2)}`);
    $('#token-usage-today-cost').text(`$${todayCost.toFixed(2)}`);

    $('#token-usage-tokenizer').text('Tokenizer: ' + (stats.tokenizer || 'Unknown'));

    // Update chart data
    chartData = getChartData(currentChartRange);
    renderChart();

    // Update model colors grid
    renderModelColorsGrid();
}


/**
 * Render the model colors grid with price inputs
 */
function renderModelColorsGrid() {
    const grid = $('#token-usage-model-colors-grid');
    if (grid.length === 0) return;

    const stats = getUsageStats();
    const models = Object.keys(stats.byModel || {}).sort();

    if (models.length === 0) {
        grid.empty().append('<div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.5; padding: 8px; text-align: center;">No models tracked yet</div>');
        return;
    }

    // If grid is already populated with the same models, don't wipe it (prevents input focus loss)
    const existingRows = grid.children('.model-config-row');
    if (existingRows.length === models.length) {
        // Assume same order check isn't needed for now, unlikely to change order rapidly
        return;
    }

    grid.empty();

    for (const model of models) {
        const color = getModelColor(model);
        const prices = getModelPrice(model);

        const row = $(`
            <div class="model-config-row" style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                <input type="color" value="${color}" data-model="${model}"
                       class="model-color-picker"
                       style="width: 20px; height: 20px; padding: 0; border: none; cursor: pointer; flex-shrink: 0; border-radius: 4px;">
                <span title="${model}" style="font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--SmartThemeBodyColor); flex: 1;">${model}</span>
                <span style="font-size: 8px; color: var(--SmartThemeBodyColor); opacity: 0.5; flex-shrink: 0;">Price</span>
                <input type="number" class="price-input-in" data-model="${model}" value="${prices.in || ''}" step="0.01" min="0" placeholder="In" title="Price per 1M input tokens" style="width: 28px; padding: 1px 2px; font-size: 8px; border-radius: 2px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); flex-shrink: 0;">
                <input type="number" class="price-input-out" data-model="${model}" value="${prices.out || ''}" step="0.01" min="0" placeholder="Out" title="Price per 1M output tokens" style="width: 28px; padding: 1px 2px; font-size: 8px; border-radius: 2px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); flex-shrink: 0;">
            </div>
        `);

        // Color picker handler
        row.find('.model-color-picker').on('change', function() {
            setModelColor(String($(this).data('model')), String($(this).val()));
            renderChart();
        });

        // Price input handlers with debounce
        let debounceTimer;
        const handlePriceChange = () => {
             const mId = model; // closure
             const pIn = row.find('.price-input-in').val();
             const pOut = row.find('.price-input-out').val();
             setModelPrice(mId, pIn, pOut);
             // Trigger UI update to recalc costs
             updateUIStats();
        };

        row.find('input[type="number"]').on('input', function() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(handlePriceChange, 500);
        });

        grid.append(row);
    }
}

/**
 * Create the settings UI in the extensions panel
 */
function createSettingsUI() {
    const settings = getSettings();
    const stats = getUsageStats();

    const html = `
        <div id="token_usage_tracker_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Usage Tracker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <!-- Chart Header: Today stats + Range selector -->
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <div style="display: flex; align-items: baseline; gap: 6px;">
                                <span style="font-size: 18px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-today-total">${formatTokens(stats.today.total)}</span>
                                <span id="token-usage-today-cost" style="font-size: 12px; color: var(--SmartThemeBodyColor); opacity: 0.8;">$0.00</span>
                                <span style="font-size: 11px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> today</span>
                            </div>
                            <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;">
                                <span id="token-usage-today-in">${formatTokens(stats.today.input || 0)}</span> in /
                                <span id="token-usage-today-out">${formatTokens(stats.today.output || 0)}</span> out
                            </div>
                        </div>
                        <div style="display: inline-flex; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; padding: 2px;">
                            <button class="token-usage-range-btn menu_button" data-value="7" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">7D</button>
                            <button class="token-usage-range-btn menu_button active" data-value="30" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">30D</button>
                            <button class="token-usage-range-btn menu_button" data-value="90" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">90D</button>
                        </div>
                    </div>

                    <!-- Chart -->
                    <div id="token-usage-chart" style="width: 100%; height: 320px; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; overflow: hidden; margin-bottom: 12px;"></div>

                    <!-- Stats Grid (Week, Month, All Time) -->
                    <div class="token-usage-stats-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px;">
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">This Week</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-week-total">${formatTokens(stats.thisWeek.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-week-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">This Month</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-month-total">${formatTokens(stats.thisMonth.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-month-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">All Time</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-alltime-total">${formatTokens(stats.allTime.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-alltime-cost">$0.00</span>
                            </div>
                        </div>
                    </div>

                    <!-- Config (Model Colors & Prices) -->
                    <div class="inline-drawer" style="margin-top: 10px;">
                        <div class="inline-drawer-toggle inline-drawer-header" style="padding: 4px 0 4px 8px;">
                            <span style="font-size: 11px;">Config</span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content">
                            <div id="token-usage-model-colors-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;"></div>
                        </div>
                    </div>

                    <!-- Controls -->
                    <div style="display: flex; align-items: center; gap: 8px; padding-left: 8px;">
                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;" id="token-usage-tokenizer">Tokenizer: ${stats.tokenizer || 'Unknown'}</div>
                        <div style="flex: 1;"></div>
                        <div id="token-usage-reset-all" class="menu_button" title="Reset all stats" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-trash"></i>&nbsp;Reset All
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const targetContainer = $('#extensions_settings2');
    if (targetContainer.length > 0) {
        targetContainer.append(html);
        console.log('[Token Usage Tracker] UI appended to extensions_settings2');
    } else {
        const fallback = $('#extensions_settings');
        if (fallback.length > 0) {
            fallback.append(html);
            console.log('[Token Usage Tracker] UI appended to extensions_settings (fallback)');
        }
    }

    // Create tooltip element and append to body (not inside extension container to avoid layout issues)
    if (!document.getElementById('token-usage-tooltip')) {
        const tooltipEl = document.createElement('div');
        tooltipEl.id = 'token-usage-tooltip';
        tooltipEl.style.cssText = 'position: fixed; display: none; background: rgba(0,0,0,0.9); color: white; padding: 8px 12px; border-radius: 6px; font-size: 11px; pointer-events: none; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(tooltipEl);
        console.log('[Token Usage Tracker] Tooltip appended to body');
    }
    tooltip = document.getElementById('token-usage-tooltip');

    // Initialize chart
    chartData = getChartData(currentChartRange);
    setTimeout(renderChart, 100);

    // Range button handlers
    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            updateChartRange(parseInt(btn.getAttribute('data-value')));
        });
    });

    $('#token-usage-reset-all').on('click', function() {
        if (confirm('Are you sure you want to reset ALL token usage data? This cannot be undone.')) {
            resetAllUsage();
            updateUIStats();
            toastr.success('All stats reset');
        }
    });

    // Subscribe to updates
    eventSource.on('tokenUsageUpdated', updateUIStats);

    // Handle container resize with ResizeObserver (handles panel width changes)
    const chartContainer = document.getElementById('token-usage-chart');
    if (chartContainer && typeof ResizeObserver !== 'undefined') {
        let lastWidth = 0;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                // Only re-render if width actually changed
                if (Math.abs(newWidth - lastWidth) > 5) {
                    lastWidth = newWidth;
                    renderChart();
                }
            }
        });
        resizeObserver.observe(chartContainer);
    }

    // Fallback: window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(renderChart, 100);
    });
}

/**
 * Patch SillyTavern's background generation functions to track tokens
 * - generateQuiet / generate_quiet (Used by Summarize, generated prompts, etc.)
 * - ConnectionManagerRequestService.sendRequest (Used by extensions like Roadway)
 */
let isTrackingBackground = false;

function patchBackgroundGenerations() {
    patchGenerateQuiet();
    patchConnectionManager();
}

function patchGenerateQuiet() {
    if (window.generateQuiet?._isPatched) return;

    // Handle snake_case variant
    if (typeof window.generateQuiet !== 'function' && typeof window.generate_quiet === 'function') {
        console.log('[Token Usage Tracker] patching generate_quiet');
        const original = window.generate_quiet;
        window.generate_quiet = async function(prompt, ...args) {
            return await handleBackgroundGeneration(original, this, [prompt, ...args], async () => {
                // Input calculation for generateQuiet (usually string)
                if (typeof prompt === 'string') return await countTokens(prompt);
                if (Array.isArray(prompt)) return await countInputTokens({ prompt });
                return 0;
            }, async (result) => {
                // Output calculation
                return typeof result === 'string' ? await countTokens(result) : 0;
            });
        };
        window.generate_quiet._isPatched = true;
        return;
    }

    if (typeof window.generateQuiet === 'function') {
        console.log('[Token Usage Tracker] Patching generateQuiet');
        const original = window.generateQuiet;
        window.generateQuiet = async function(prompt, ...args) {
            return await handleBackgroundGeneration(original, this, [prompt, ...args], async () => {
                if (typeof prompt === 'string') return await countTokens(prompt);
                if (Array.isArray(prompt)) return await countInputTokens({ prompt });
                return 0;
            }, async (result) => {
                return typeof result === 'string' ? await countTokens(result) : 0;
            });
        };
        window.generateQuiet._isPatched = true;
    }
}

function patchConnectionManager() {
    // Poll for the service as it might load after this extension
    const checkInterval = setInterval(() => {
        try {
            const context = getContext();
            const service = context?.ConnectionManagerRequestService;

            if (service && typeof service.sendRequest === 'function' && !service.sendRequest._isPatched) {
                console.log('[Token Usage Tracker] Patching ConnectionManagerRequestService.sendRequest');
                const original = service.sendRequest;

                service.sendRequest = async function(profileId, messages, ...args) {
                    return await handleBackgroundGeneration(original, this, [profileId, messages, ...args], async () => {
                        // Input calculation (messages array)
                        // Wrapping in object to match countInputTokens signature expectation
                        return await countInputTokens({ prompt: messages });
                    }, async (result) => {
                        // Output calculation (ExtractedData .content)
                        if (result && typeof result.content === 'string') {
                            return await countTokens(result.content);
                        }
                        return 0;
                    });
                };

                service.sendRequest._isPatched = true;
                clearInterval(checkInterval);
            }
        } catch (e) {
            // Ignore errors during polling
        }
    }, 1000);

    // Stop polling after 30 seconds
    setTimeout(() => clearInterval(checkInterval), 30000);
}

/**
 * Generic handler for background generations with recursion guard
 */
async function handleBackgroundGeneration(originalFn, context, args, inputCounter, outputCounter) {
    // Avoid double counting if one patched function calls another
    if (isTrackingBackground) {
        return await originalFn.apply(context, args);
    }

    let result;
    let inputTokens = 0;
    const modelId = getCurrentModelId();

    try {
        isTrackingBackground = true;

        // Count input tokens
        try {
            inputTokens = await inputCounter();
            console.log(`[Token Usage Tracker] Counting background input. Tokens: ${inputTokens}`);
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background input:', e);
        }

        // Execute original
        result = await originalFn.apply(context, args);

        // Count output tokens
        try {
            const outputTokens = await outputCounter(result);
            if (outputTokens > 0 || inputTokens > 0) {
                recordUsage(inputTokens, outputTokens, null, modelId);
                console.log(`[Token Usage Tracker] Background usage recorded: ${inputTokens} in, ${outputTokens} out`);
            }
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background output:', e);
        }
    } finally {
        isTrackingBackground = false;
    }

    return result;
}

jQuery(async () => {
    console.log('[Token Usage Tracker] Initializing...');

    loadSettings();
    registerSlashCommands();
    createSettingsUI();

    // Attempt to patch background generation functions
    patchBackgroundGenerations();

    // Subscribe to events
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);

    // Log current tokenizer
    try {
        const { tokenizerName } = getFriendlyTokenizerName(main_api);
        console.log(`[Token Usage Tracker] Using tokenizer: ${tokenizerName}`);
    } catch (e) {
        console.log('[Token Usage Tracker] Tokenizer will be determined when API is connected');
    }

    console.log('[Token Usage Tracker] Use /tokenusage to see stats, /tokenreset to reset session');

    // Emit initial stats for any listening UI
    setTimeout(() => {
        eventSource.emit('tokenUsageUpdated', getUsageStats());
    }, 1000);
});
