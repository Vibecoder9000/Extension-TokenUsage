/**
 * Token Usage Tracker Extension for SillyTavern
 * Tracks input/output token usage across messages with time-based aggregation
 *
 * Uses SillyTavern's native tokenizer system for accurate counting:
 * - getTokenCountAsync() for async token counting
 * - Respects user's tokenizer settings (BEST_MATCH, model-specific, etc.)
 */

import { eventSource, event_types, main_api, streamingProcessor, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, getFriendlyTokenizerName } from '../../../tokenizers.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getGeneratingModel } from '../../../../script.js';
import { pricing } from './dict.js';
import { migrateUsageV1, deserializeUsage, serializeUsage, buildUsageCsv, createEmptyRuntime } from './storage.js';

const extensionName = 'token-usage-tracker';

const defaultSettings = {
    showInTopBar: true,
    trackCache: true, // Whether to track and account for prompt cache
    modelColors: {}, // { "gpt-4o": "#6366f1", "claude-3-opus": "#8b5cf6", ... }
    // Prices per 1M tokens: { "gpt-4o": { in: 2.5, out: 10, cache?: 0.25 }, ... }
    modelPrices: {},
    // Cache simulation configuration
    cacheSimulation: {
        enabled: true,
        minThreshold: 1024, // Min tokens to qualify for KV cache
        ttlMinutes: 10,     // Cache TTL in minutes (0 = no expiration check)
    },
    // Accumulated usage data (persisted in compact v2 form via storage.js; byDay/byModel
    // live only in the expanded runtime copy)
    usage: {
        session: { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0, startTime: null },
        allTime: { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0 },
    },
};

/** Expanded usage data rebuilt from the compact stored form on load */
let usageRuntime = null;

/**
 * Load extension settings, merging with defaults
 */
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    if (settings.trackCache === undefined) {
        settings.trackCache = true;
    }
    if (!settings.modelColors) settings.modelColors = {};
    if (!settings.modelPrices) settings.modelPrices = {};
    if (!settings.cacheSimulation) {
        settings.cacheSimulation = structuredClone(defaultSettings.cacheSimulation);
    }

    // Usage is stored in compact v2 form; migrate older layouts once, then expand
    // into the runtime copy. Migration also drops the dead legacy buckets
    // (byHour/byWeek/byMonth/byChat), which current code never writes or displays.
    if (!settings.usage || settings.usage.v !== 2) {
        settings.usage = migrateUsageV1(settings.usage || {});
        console.log('[Token Usage Tracker] Migrated usage data to compact v2 storage format');
    }
    usageRuntime = deserializeUsage(settings.usage);

    // Initialize session start time
    if (!usageRuntime.session.startTime) {
        usageRuntime.session.startTime = new Date().toISOString();
    }

    return settings;
}

/**
 * Write the compact form of the runtime usage data back into extension settings
 */
function persistUsage() {
    const settings = getSettings();
    settings.usage = serializeUsage(usageRuntime);
    saveSettings();
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
 * Uses SillyTavern's asynchronous tokenizer API and its token cache.
 * @param {string} text - Text to tokenize
 * @returns {Promise<number>} Token count
 */
async function countTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    try {
        // getTextTokens() performs a synchronous XHR for server tokenizers, which
        // blocks the Generate flow until the tokenizer responds. The async count
        // API uses the same configured tokenizer and cache without freezing the UI.
        return await getTokenCountAsync(text);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting tokens:', error);
        // Ultimate fallback: character-based estimate
        return Math.ceil(text.length / 3.35);
    }
}

/**
 * Record token usage into all relevant buckets
 * @param {number} inputTokens - Tokens in the user message
 * @param {number} outputTokens - Tokens in the AI response
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 * @param {{cost?: number|null, source?: string|null, hasTokenCounts?: boolean}} [apiUsage] - Optional API-reported usage metadata
 * @param {number} [cacheReadTokens=0] - Tokens served from prompt cache
 */
function recordUsage(inputTokens, outputTokens, chatId = null, modelId = null, apiUsage = {}, cacheReadTokens = 0) {
    const usage = usageRuntime;
    const now = new Date();
    const cr = Math.max(0, cacheReadTokens || 0);
    const totalTokens = inputTokens + outputTokens + cr;
    const exactCost = Number.isFinite(apiUsage?.cost) ? apiUsage.cost : null;

    const addTokens = (bucket) => {
        bucket.input = (bucket.input || 0) + inputTokens;
        bucket.cache_read = (bucket.cache_read || 0) + cr;
        bucket.output = (bucket.output || 0) + outputTokens;
        bucket.total = (bucket.total || 0) + totalTokens;
        bucket.messageCount = (bucket.messageCount || 0) + 1;
        if (exactCost !== null) {
            bucket.cost = (bucket.cost || 0) + exactCost;
            bucket.costedInput = (bucket.costedInput || 0) + inputTokens;
            bucket.costedOutput = (bucket.costedOutput || 0) + outputTokens;
        }
    };

    // Session
    addTokens(usage.session);

    // All-time
    addTokens(usage.allTime);

    // By day
    const dayKey = getDayKey(now);
    if (!usage.byDay[dayKey]) usage.byDay[dayKey] = { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0, models: {} };
    addTokens(usage.byDay[dayKey]);

    // Track model within day for stacked chart (with input/output breakdown for cost calculation)
    if (modelId) {
        if (!usage.byDay[dayKey].models) usage.byDay[dayKey].models = {};
        if (!usage.byDay[dayKey].models[modelId]) {
            usage.byDay[dayKey].models[modelId] = { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0 };
        }
        const modelData = usage.byDay[dayKey].models[modelId];
        modelData.input += inputTokens;
        modelData.cache_read = (modelData.cache_read || 0) + cr;
        modelData.output += outputTokens;
        modelData.total += totalTokens;
        modelData.messageCount = (modelData.messageCount || 0) + 1;
        if (exactCost !== null) {
            modelData.cost = (modelData.cost || 0) + exactCost;
            modelData.costedInput = (modelData.costedInput || 0) + inputTokens;
            modelData.costedOutput = (modelData.costedOutput || 0) + outputTokens;
        }
    }

    // By model (aggregate)
    if (modelId) {
        if (!usage.byModel[modelId]) usage.byModel[modelId] = { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0 };
        addTokens(usage.byModel[modelId]);
    }

    persistUsage();

    // Emit custom event for UI updates
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    const estimatedCost = exactCost === null ? calculateCost(inputTokens, outputTokens, modelId, cr) : 0;
    const costLog = exactCost !== null
        ? `, cost: $${exactCost.toFixed(6)} (reported by API)`
        : estimatedCost > 0
            ? `, cost: $${estimatedCost.toFixed(6)} (model pricing)`
            : '';
    const countSource = apiUsage?.hasTokenCounts ? 'reported by API' : `counted with ${getFriendlyTokenizerName(main_api).tokenizerName}`;
    console.log(`[Token Usage Tracker] Recorded: +${inputTokens} input, +${cr} cache_read, +${outputTokens} output, model: ${modelId || 'unknown'}${costLog} (${countSource})`);
}

/**
 * Reset session usage
 */
function resetSession() {
    usageRuntime.session = {
        input: 0,
        output: 0,
        total: 0,
        messageCount: 0,
        startTime: new Date().toISOString(),
    };
    persistUsage();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] Session reset');
}

/**
 * Reset all usage data
 */
function resetAllUsage() {
    usageRuntime = createEmptyRuntime();
    usageRuntime.session.startTime = new Date().toISOString();
    persistUsage();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] All usage data reset');
}

/**
 * Download the full usage history as CSV (one row per day x model)
 */
function exportUsageCsv() {
    const isCacheActive = getSettings().trackCache !== false;
    const csv = buildUsageCsv(usageRuntime, calculateStoredOrEstimatedCost, isCacheActive);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `token-usage-${getDayKey()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toastr.success('Usage CSV downloaded');
}

/**
 * Get comprehensive usage statistics
 * @returns {Object} Usage statistics object
 */
function getUsageStats() {
    const usage = usageRuntime;
    const now = new Date();
    const currentWeekKey = getWeekKey(now);
    const currentMonthKey = getMonthKey(now);
    const thisWeek = { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0 };
    const thisMonth = { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0 };

    // Get current tokenizer info for display
    let tokenizerInfo = { tokenizerName: 'Unknown' };
    try {
        tokenizerInfo = getFriendlyTokenizerName(main_api);
    } catch (e) {
        // Ignore if not available yet
    }

    for (const [dayKey, data] of Object.entries(usage.byDay)) {
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        if (getWeekKey(date) === currentWeekKey) {
            thisWeek.input += data.input || 0;
            thisWeek.cache_read += data.cache_read || 0;
            thisWeek.output += data.output || 0;
            thisWeek.total += data.total || 0;
            thisWeek.messageCount += data.messageCount || 0;
        }

        if (getMonthKey(date) === currentMonthKey) {
            thisMonth.input += data.input || 0;
            thisMonth.cache_read += data.cache_read || 0;
            thisMonth.output += data.output || 0;
            thisMonth.total += data.total || 0;
            thisMonth.messageCount += data.messageCount || 0;
        }
    }

    return {
        session: { ...usage.session },
        allTime: { ...usage.allTime },
        today: usage.byDay[getDayKey(now)] || { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0, models: {} },
        thisWeek,
        thisMonth,
        currentChat: null, // Will be populated if context available
        // Metadata
        tokenizer: tokenizerInfo.tokenizerName,
        // Raw data for advanced aggregation
        byDay: { ...usage.byDay },
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
    const usage = usageRuntime;

    const result = { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0 };

    for (const [day, data] of Object.entries(usage.byDay)) {
        if (day >= startDate && day <= endDate) {
            result.input += data.input || 0;
            result.cache_read += data.cache_read || 0;
            result.output += data.output || 0;
            result.total += data.total || 0;
            result.messageCount += data.messageCount || 0;
        }
    }

    return result;
}

/**
 * Parses the OpenAI/Anthropic-compatible usage shape returned by API.
 * Extracts native cached token counts if present.
 * @param {any} apiUsage
 * @returns {{input: number, cache_read: number, output: number, total: number, rawPromptTokens: number, cost: number|null, source: string, hasTokenCounts: true, hasCacheTokens: boolean}|null}
 */
function parseApiUsage(apiUsage) {
    if (!apiUsage || typeof apiUsage !== 'object') return null;

    let input = apiUsage.prompt_tokens;
    let output = apiUsage.completion_tokens;
    let total = apiUsage.total_tokens;

    // Check for Anthropic style tokens (input_tokens, output_tokens)
    if (input === undefined && typeof apiUsage.input_tokens === 'number') {
        input = apiUsage.input_tokens;
    }
    if (output === undefined && typeof apiUsage.output_tokens === 'number') {
        output = apiUsage.output_tokens;
    }

    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0
        || typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
        return null;
    }

    // Check for native prompt cache tokens from various providers:
    // 1. OpenAI / One-API: prompt_tokens_details.cached_tokens or cached_tokens
    // 2. Anthropic: cache_read_input_tokens
    // 3. DeepSeek: prompt_cache_hit_tokens
    // 4. Gemini: cached_content_token_count
    let cache_read = 0;
    if (typeof apiUsage.prompt_tokens_details?.cached_tokens === 'number') {
        cache_read = apiUsage.prompt_tokens_details.cached_tokens;
    } else if (typeof apiUsage.cached_tokens === 'number') {
        cache_read = apiUsage.cached_tokens;
    } else if (typeof apiUsage.cache_read_input_tokens === 'number') {
        cache_read = apiUsage.cache_read_input_tokens;
    } else if (typeof apiUsage.prompt_cache_hit_tokens === 'number') {
        cache_read = apiUsage.prompt_cache_hit_tokens;
    } else if (typeof apiUsage.cached_content_token_count === 'number') {
        cache_read = apiUsage.cached_content_token_count;
    }

    // In OpenAI/DeepSeek/Gemini, prompt_tokens includes cached_tokens.
    // Anthropic input_tokens does NOT include cache_read_input_tokens.
    const isAnthropicStyle = typeof apiUsage.input_tokens === 'number' && typeof apiUsage.cache_read_input_tokens === 'number';
    const totalPrompt = isAnthropicStyle ? (input + cache_read) : input;
    let netInput = input;
    if (!isAnthropicStyle && cache_read > 0) {
        netInput = Math.max(0, input - cache_read);
    }

    if (typeof total !== 'number' || !Number.isFinite(total)) {
        total = netInput + cache_read + output;
    }

    const rawCost = apiUsage.cost ?? apiUsage.cost_details?.upstream_inference_cost;
    const parsedCost = rawCost === null || rawCost === undefined || rawCost === '' ? null : Number(rawCost);
    const cost = Number.isFinite(parsedCost) && parsedCost >= 0 ? parsedCost : null;

    return {
        input: netInput,
        cache_read,
        output,
        total,
        rawPromptTokens: totalPrompt,
        cost,
        source: 'api_usage',
        hasTokenCounts: true,
        hasCacheTokens: cache_read > 0,
    };
}

/**
 * Get usage for a specific chat
 * Per-chat tracking was removed with the v2 storage format; kept for API compatibility
 * @returns {Object} Zeroed usage
 */
function getChatUsage() {
    return { input: 0, output: 0, cache_read: 0, total: 0, messageCount: 0 };
}

/** Cache state per chat to track KV cache prefix: chatId -> { prompt: Array|string, timestamp: number } */
const chatPromptCache = new Map();

/**
 * Compare two messages for prompt cache prefix matching
 */
function isMessageEqual(m1, m2) {
    if (!m1 || !m2) return false;
    if (m1.role !== m2.role) return false;
    if (typeof m1.content === 'string' && typeof m2.content === 'string') {
        return m1.content === m2.content;
    }
    try {
        return JSON.stringify(m1.content) === JSON.stringify(m2.content);
    } catch (e) {
        return false;
    }
}

/**
 * Calculate token count for a single message object
 */
async function countMessageTokens(message) {
    if (!message) return 0;
    let tokens = 0;
    if (message.content) {
        if (typeof message.content === 'string') {
            tokens += await countTokens(message.content);
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === 'text' && part.text) {
                    tokens += await countTokens(part.text);
                } else if (part.type === 'image_url' || part.type === 'image') {
                    tokens += 765;
                }
            }
        }
    }
    if (message.role) tokens += 1;
    if (message.name) tokens += await countTokens(message.name);
    if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            if (tc.function?.name) tokens += await countTokens(tc.function.name);
            if (tc.function?.arguments) tokens += await countTokens(tc.function.arguments);
        }
    }
    tokens += 3; // per-message envelope overhead
    return tokens;
}

/**
 * Infer cache tokens from previous prompt for this chat.
 * @param {object} generate_data - generation data containing the full prompt
 * @param {string} chatId - chat ID or identifier
 * @returns {Promise<number>} - simulated cached tokens
 */
async function inferPromptCacheTokens(generate_data, chatId) {
    const settings = getSettings();
    if (settings.trackCache === false) return 0;
    const simCfg = settings.cacheSimulation || {};
    if (simCfg.enabled === false) return 0;

    const minThreshold = simCfg.minThreshold ?? 1024;
    const ttlMinutes = simCfg.ttlMinutes ?? 10;
    const ttlMs = ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : 0;

    const lastState = chatPromptCache.get(chatId);
    if (!lastState || !lastState.prompt) return 0;

    if (ttlMs > 0 && (Date.now() - lastState.timestamp) > ttlMs) {
        console.log(`[Token Usage Tracker] Cache simulation: TTL expired (${Math.round((Date.now() - lastState.timestamp) / 60000)}m > ${ttlMinutes}m)`);
        return 0;
    }

    const currentPrompt = generate_data.prompt;
    const lastPrompt = lastState.prompt;
    let simulatedCacheTokens = 0;

    if (Array.isArray(currentPrompt) && Array.isArray(lastPrompt)) {
        let matchingCount = 0;
        const maxLen = Math.min(currentPrompt.length, lastPrompt.length);
        for (let i = 0; i < maxLen; i++) {
            if (isMessageEqual(currentPrompt[i], lastPrompt[i])) {
                matchingCount++;
            } else {
                break;
            }
        }

        if (matchingCount > 0) {
            for (let i = 0; i < matchingCount; i++) {
                simulatedCacheTokens += await countMessageTokens(currentPrompt[i]);
            }
            console.log(`[Token Usage Tracker] Cache simulation: matched ${matchingCount}/${currentPrompt.length} messages (${simulatedCacheTokens} tokens)`);
        }
    } else if (typeof currentPrompt === 'string' && typeof lastPrompt === 'string') {
        let commonLen = 0;
        const maxLen = Math.min(currentPrompt.length, lastPrompt.length);
        while (commonLen < maxLen && currentPrompt.charCodeAt(commonLen) === lastPrompt.charCodeAt(commonLen)) {
            commonLen++;
        }
        if (commonLen > 0) {
            const prefixStr = currentPrompt.slice(0, commonLen);
            simulatedCacheTokens = await countTokens(prefixStr);
            console.log(`[Token Usage Tracker] Cache simulation: matched prefix string (${simulatedCacheTokens} tokens)`);
        }
    }

    if (simulatedCacheTokens < minThreshold) {
        if (simulatedCacheTokens > 0) {
            console.log(`[Token Usage Tracker] Cache simulation: ${simulatedCacheTokens} tokens below minThreshold (${minThreshold}), treated as 0`);
        }
        return 0;
    }

    return simulatedCacheTokens;
}

/** @type {Promise<number>|null} Promise that resolves to input token count - started early, awaited later */
let pendingInputTokensPromise = null;
let pendingSimulatedCachePromise = null;
let pendingModelId = null;
let pendingChatId = null;
let pendingGeneratePrompt = null;
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
        } else if (Array.isArray(generate_data.prompt)) {
            // For chat completion APIs (OpenAI) - prompt is an array of messages
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
    pendingModelId = getGeneratingModel();

    const context = getContext();
    pendingChatId = context.chatMetadata?.chat_id || (context.characterId !== undefined ? String(context.characterId) : 'default');
    pendingGeneratePrompt = generate_data.prompt;

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

    // Start cache simulation in parallel
    pendingSimulatedCachePromise = inferPromptCacheTokens(generate_data, pendingChatId)
        .catch(error => {
            console.error('[Token Usage Tracker] Error inferring cache tokens:', error);
            return 0;
        });
}

/**
 * Handle GENERATION_STARTED event - capture pre-continue state
 * This fires before the API call, allowing us to snapshot the current message state
 * for 'continue' type generations so we can calculate the delta later.
 * @param {string} type - Generation type: 'normal', 'continue', 'swipe', 'regenerate', 'quiet', etc.
 * @param {object} params - Generation parameters
 * @param {boolean} isDryRun - Whether this is a dry run
 */
let isQuietGeneration = false;
let isImpersonateGeneration = false;

async function handleGenerationStarted(type, params, isDryRun) {
    if (isDryRun) return;

    // Track the generation type for special handling
    isQuietGeneration = (type === 'quiet');
    isImpersonateGeneration = (type === 'impersonate');

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

        const apiUsage = parseApiUsage(message.extra?.api_usage);
        let inputTokens;
        let outputTokens;
        let cacheReadTokens = 0;

        const settings = getSettings();
        const isCacheTracked = settings.trackCache !== false;
        const simulatedCacheTokens = (isCacheTracked && pendingSimulatedCachePromise) ? (await pendingSimulatedCachePromise) : 0;

        if (apiUsage) {
            outputTokens = apiUsage.output;
            if (!isCacheTracked) {
                // When cache tracking is disabled, all prompt tokens count as input
                cacheReadTokens = 0;
                inputTokens = apiUsage.rawPromptTokens ?? (apiUsage.input + (apiUsage.cache_read || 0));
                console.log(`[Token Usage Tracker] Cache tracking disabled. Using full prompt tokens: ${inputTokens} in, ${outputTokens} out`);
            } else if (apiUsage.hasCacheTokens) {
                // API returned native cache tokens
                cacheReadTokens = apiUsage.cache_read;
                inputTokens = apiUsage.input;
                console.log(`[Token Usage Tracker] Using API-reported usage: ${inputTokens} in, ${cacheReadTokens} cache_read, ${outputTokens} out${apiUsage.cost !== null ? `, $${apiUsage.cost.toFixed(6)}` : ''}`);
            } else {
                // API reported usage without cache breakdown (e.g. proxy site omitting cached_tokens)
                const rawPrompt = apiUsage.rawPromptTokens ?? apiUsage.input;
                cacheReadTokens = Math.min(simulatedCacheTokens, rawPrompt);
                inputTokens = Math.max(0, rawPrompt - cacheReadTokens);
                console.log(`[Token Usage Tracker] Using API-reported tokens with simulated cache: ${inputTokens} net in, ${cacheReadTokens} cache_read (from ${rawPrompt} prompt tokens), ${outputTokens} out`);
            }
        } else {
            // Use SillyTavern's pre-calculated token count if available.
            // This already includes reasoning tokens when power_user.message_token_count_enabled is true.
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

            const totalIn = await pendingInputTokensPromise;
            if (!isCacheTracked) {
                cacheReadTokens = 0;
                inputTokens = totalIn;
                console.log(`[Token Usage Tracker] Cache tracking disabled. Using full local tokens: ${inputTokens} in, ${outputTokens} out`);
            } else {
                cacheReadTokens = Math.min(simulatedCacheTokens, totalIn);
                inputTokens = Math.max(0, totalIn - cacheReadTokens);
                console.log(`[Token Usage Tracker] Using local tokenizer with simulated cache: ${inputTokens} net in, ${cacheReadTokens} cache_read (from ${totalIn} total in), ${outputTokens} out`);
            }
        }

        // For local-tokenizer continue records, subtract the pre-continue count.
        // API-reported completion tokens already describe the generated response.
        if (!apiUsage && type === 'continue' && preContinueTokenCount > 0) {
            const originalOutputTokens = outputTokens;
            outputTokens = Math.max(0, outputTokens - preContinueTokenCount);
            console.log(`[Token Usage Tracker] Continue type: ${originalOutputTokens} total - ${preContinueTokenCount} pre-continue = ${outputTokens} new tokens`);
        }

        // Reset pre-continue state
        const savedPreContinueCount = preContinueTokenCount;
        preContinueTokenCount = 0;

        // Drain pending promises so any tokenizer error handling has completed.
        if (pendingInputTokensPromise) pendingInputTokensPromise.catch(() => {});
        if (pendingSimulatedCachePromise) pendingSimulatedCachePromise.catch(() => {});

        const modelId = pendingModelId;
        const currentChatId = pendingChatId || context.chatMetadata?.chat_id || (context.characterId !== undefined ? String(context.characterId) : null);

        // Update chatPromptCache for next turn
        if (currentChatId && pendingGeneratePrompt) {
            let nextCachedPrompt;
            if (Array.isArray(pendingGeneratePrompt)) {
                nextCachedPrompt = [
                    ...pendingGeneratePrompt,
                    { role: 'assistant', content: message.mes || '' },
                ];
            } else if (typeof pendingGeneratePrompt === 'string') {
                nextCachedPrompt = pendingGeneratePrompt + '\n' + (message.mes || '');
            }
            chatPromptCache.set(currentChatId, {
                prompt: nextCachedPrompt,
                timestamp: Date.now(),
            });
        }

        pendingInputTokensPromise = null;
        pendingSimulatedCachePromise = null;
        pendingModelId = null;
        pendingChatId = null;
        pendingGeneratePrompt = null;

        recordUsage(inputTokens, outputTokens, currentChatId, modelId, apiUsage, cacheReadTokens);

        console.log(`[Token Usage Tracker] Recorded exchange: ${inputTokens} in, ${cacheReadTokens} cache_read, ${outputTokens} out, model: ${modelId || 'unknown'}${savedPreContinueCount > 0 ? ' (continue delta)' : ''}`);
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
        const settings = getSettings();
        const isCacheTracked = settings.trackCache !== false;
        const simulatedCacheTokens = (isCacheTracked && pendingSimulatedCachePromise) ? (await pendingSimulatedCachePromise) : 0;
        const cacheReadTokens = isCacheTracked ? Math.min(simulatedCacheTokens, inputTokens) : 0;
        const netInput = isCacheTracked ? Math.max(0, inputTokens - cacheReadTokens) : inputTokens;
        const modelId = pendingModelId;
        const currentChatId = pendingChatId || null;

        pendingInputTokensPromise = null;
        pendingSimulatedCachePromise = null;
        pendingModelId = null;
        pendingChatId = null;
        pendingGeneratePrompt = null;
        preContinueTokenCount = 0; // Reset continue state too

        // Record the usage - input tokens were sent even if generation was stopped
        recordUsage(netInput, outputTokens, currentChatId, modelId, {}, cacheReadTokens);

        console.log(`[Token Usage Tracker] Recorded stopped generation: ${netInput} in, ${cacheReadTokens} cache_read, ${outputTokens} out (partial), model: ${modelId || 'unknown'}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling stopped generation:', error);
        // Reset pending tokens even on error to prevent double counting
        pendingInputTokensPromise = null;
        pendingSimulatedCachePromise = null;
        pendingModelId = null;
        pendingChatId = null;
        pendingGeneratePrompt = null;
        preContinueTokenCount = 0;
    }
}

/**
 * Handle chat changed event
 */
function handleChatChanged(chatId) {
    // Reset pending tokens when chat changes to prevent cross-chat counting
    pendingInputTokensPromise = null;
    pendingSimulatedCachePromise = null;
    pendingModelId = null;
    pendingChatId = null;
    pendingGeneratePrompt = null;
    preContinueTokenCount = 0;
    isQuietGeneration = false;
    isImpersonateGeneration = false;
    console.log(`[Token Usage Tracker] Chat changed to: ${chatId}`);
}

/**
 * Handle impersonate ready event - count output tokens for impersonation
 * This fires when impersonation completes and puts text into the input field
 * @param {string} text - The generated impersonation text
 */
async function handleImpersonateReady(text) {
    if (!pendingInputTokensPromise) return;

    try {

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;

        // Count output tokens from the impersonated text
        let outputTokens = 0;
        if (text && typeof text === 'string') {
            outputTokens = await countTokens(text);
        }

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId);


        // Reset impersonate state
        isImpersonateGeneration = false;
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling impersonate ready:', error);
        pendingInputTokensPromise = null;
        pendingModelId = null;
        isImpersonateGeneration = false;
    }
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
    if (typeof num !== 'number' || !Number.isFinite(num)) return '0';
    return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Adaptive formatting for dense card columns (k/M compact notation)
 */
function formatNumberAdaptive(num) {
    if (typeof num !== 'number' || !Number.isFinite(num)) return '0';
    const isNeg = num < 0;
    const abs = Math.abs(num);
    let str = '0';
    if (abs === 0) {
        str = '0';
    } else if (abs < 1000) {
        str = abs.toString();
    } else if (abs < 10000) {
        str = abs.toLocaleString('en-US');
    } else if (abs < 1000000) {
        const k = abs / 1000;
        str = (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + 'k';
    } else if (abs < 10000000) {
        str = (abs / 1000000).toFixed(2) + 'M';
    } else {
        str = (abs / 1000000).toFixed(1) + 'M';
    }
    return isNeg ? '-' + str : str;
}


/**
 * Normalize model IDs for compatibility matching.
 * Handles case and punctuation variants while preserving semantic version differences.
 * @param {string} modelId
 * @returns {string}
 */
function normalizeModelIdForLookup(modelId) {
    if (!modelId) return '';

    let normalized = String(modelId).trim().toLowerCase();

    // Strip live-stat suffixes (" | 14:12 | ...") and normalize version delimiters.
    normalized = normalized.split('|')[0].trim();
    normalized = normalized.replace(/(\d)[\s._/-]+(?=\d)/g, '$1');

    // Split words and numbers for IDs like "qwen3.6-plus" vs "Qwen 3.6 Plus".
    normalized = normalized.replace(/([a-z])(\d)/g, '$1 $2');
    normalized = normalized.replace(/(\d)([a-z])/g, '$1 $2');

    normalized = normalized.replace(/[:/]+/g, ' ');
    normalized = normalized.replace(/[\s._-]+/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
}

/**
 * Build candidate lookup forms for model ID matching.
 * @param {string} modelId
 * @returns {string[]}
 */
function getModelLookupCandidates(modelId) {
    const raw = String(modelId || '').trim();
    if (!raw) return [];

    const candidates = new Set();
    const suffixPattern = /(?:[\s._:-]+)(?:it|instruct|chat|agentic|free)$/i;
    const addCandidate = (value) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) return;
        candidates.add(trimmed);

        // Add progressively stripped terminal tags ("-it", ":free", "-thinking", etc).
        let variant = trimmed;
        while (true) {
            const stripped = variant.replace(suffixPattern, '').trim();
            if (!stripped || stripped === variant) break;
            candidates.add(stripped);
            variant = stripped;
        }
    };

    addCandidate(raw);
    const beforePipe = raw.split('|')[0].trim();
    addCandidate(beforePipe);

    if (beforePipe.includes('/')) {
        const tail = beforePipe.split('/').filter(Boolean).pop();
        addCandidate(tail);
    }

    if (beforePipe.includes(':')) {
        const tail = beforePipe.split(':').filter(Boolean).pop();
        addCandidate(tail);
    }

    const withoutParens = beforePipe.replace(/\([^)]*\)/g, '').trim();
    addCandidate(withoutParens);

    return [...candidates];
}

/**
 * Build normalized lookup map for a pricing dictionary.
 * @param {Record<string, {in: number, out: number}>} priceMap
 * @returns {Map<string, string>}
 */
function buildNormalizedPriceLookupMap(priceMap) {
    const normalizedMap = new Map();
    const getPriority = (key) => /:free$/i.test(key) ? 0 : 1;
    for (const key of Object.keys(priceMap || {})) {
        const candidates = getModelLookupCandidates(key);
        for (const candidate of candidates) {
            const normalized = normalizeModelIdForLookup(candidate);
            if (!normalized) continue;

            if (!normalizedMap.has(normalized)) {
                normalizedMap.set(normalized, key);
                continue;
            }

            const existingKey = normalizedMap.get(normalized);
            if (existingKey && getPriority(key) > getPriority(existingKey)) {
                normalizedMap.set(normalized, key);
            }
        }
    }
    return normalizedMap;
}

const LOOKUP_STOPWORDS = new Set([
    'it', 'instruct', 'chat', 'thinking', 'reasoning', 'agentic', 'free',
    'preview', 'customtools', 'customtool', 'tools', 'tool', 'gguf', 'ud',
]);

const LOOKUP_QUALIFIERS = new Set([
    'preview', 'customtools', 'customtool', 'thinking', 'reasoning', 'agentic',
    'image', 'vision', 'audio', 'search', 'fast', 'lite', 'mini', 'beta', 'exp',
]);

const LOOKUP_TOKEN_SYNONYMS = {
    expert: 'pro',
};

function tokenizeModelIdForLookup(modelId) {
    let value = String(modelId || '').toLowerCase();
    value = value.split('|')[0].trim();
    value = value.replace(/([a-z])(\d)/g, '$1 $2');
    value = value.replace(/(\d)([a-z])/g, '$1 $2');
    value = value.replace(/[^\w]+/g, ' ');
    const tokens = value.split(/\s+/).filter(Boolean);

    const result = [];
    for (const tokenRaw of tokens) {
        let token = tokenRaw.toLowerCase();
        if (/^\d{5,}$/.test(token)) continue; // date/build identifiers
        if (/^iq\d+[a-z]*$/.test(token)) continue; // quantization labels
        if (LOOKUP_STOPWORDS.has(token)) continue;
        token = LOOKUP_TOKEN_SYNONYMS[token] || token;
        if (!token || LOOKUP_STOPWORDS.has(token)) continue;
        if (token.length <= 1) continue;
        result.push(token);
    }

    return [...new Set(result)];
}

function extractVersionInfo(modelId) {
    const composite = new Set();
    const major = new Set();
    let value = String(modelId || '').toLowerCase();
    value = value.replace(/([a-z])(\d)/g, '$1 $2');
    value = value.replace(/(\d)([a-z])/g, '$1 $2');

    const compositeRegex = /(^|[^0-9])(\d+(?:[._-]\d+)+)(?=$|[^0-9])/g;
    let match;
    while ((match = compositeRegex.exec(value)) !== null) {
        const raw = match[2];
        const parts = raw.split(/[._-]+/).filter(Boolean);
        if (parts.length < 2) continue;
        while (parts.length > 2 && parts[parts.length - 1].length >= 4) {
            parts.pop();
        }
        if (parts.length < 2) continue;
        if (parts.slice(0, 2).some(p => p.length >= 4)) continue; // likely date-only token chain
        const majorPart = String(Number.parseInt(parts[0], 10));
        const minorPart = String(Number.parseInt(parts[1], 10));
        if (!Number.isFinite(Number(majorPart)) || !Number.isFinite(Number(minorPart))) continue;
        composite.add(`${majorPart}.${minorPart}`);
        major.add(majorPart);
    }

    const majorRegex = /(^|[^0-9a-z])(\d{1,2})(?=$|[^0-9a-z])/g;
    while ((match = majorRegex.exec(value)) !== null) {
        const part = String(Number.parseInt(match[2], 10));
        if (Number.isFinite(Number(part))) {
            major.add(part);
        }
    }

    return { composite, major };
}

function extractLookupQualifiers(modelId) {
    let value = String(modelId || '').toLowerCase();
    value = value.split('|')[0].trim();
    value = value.replace(/([a-z])(\d)/g, '$1 $2');
    value = value.replace(/(\d)([a-z])/g, '$1 $2');
    value = value.replace(/[^\w]+/g, ' ');
    const qualifiers = new Set();
    for (const token of value.split(/\s+/).filter(Boolean)) {
        if (LOOKUP_QUALIFIERS.has(token)) {
            qualifiers.add(token);
        }
    }
    return qualifiers;
}

function getMaxCompositeVersion(composites) {
    let max = 0;
    for (const composite of composites) {
        const [majorPart, minorPart] = composite.split('.');
        const major = Number.parseInt(majorPart, 10);
        const minor = Number.parseInt(minorPart, 10);
        if (!Number.isFinite(major) || !Number.isFinite(minor)) continue;
        const rank = (major * 1000) + minor;
        if (rank > max) max = rank;
    }
    return max;
}

function buildLookupProfile(modelId) {
    const tokenList = tokenizeModelIdForLookup(modelId);
    const tokenSet = new Set(tokenList);
    const version = extractVersionInfo(modelId);
    const qualifiers = extractLookupQualifiers(modelId);
    const source = String(modelId || '').toLowerCase();
    const vendor = source.includes('/') ? source.split('/')[0] : '';
    return {
        modelId,
        tokenList,
        tokenSet,
        vendor,
        qualifiers,
        compositeVersions: version.composite,
        majorVersions: version.major,
        maxCompositeVersion: getMaxCompositeVersion(version.composite),
        isFree: /:free$/i.test(modelId),
    };
}

function hasIntersection(a, b) {
    for (const value of a) {
        if (b.has(value)) return true;
    }
    return false;
}

function semanticMatchScore(queryProfile, targetProfile) {
    const querySize = queryProfile.tokenList.length;
    if (querySize === 0) return Number.NEGATIVE_INFINITY;

    let common = 0;
    for (const token of queryProfile.tokenList) {
        if (targetProfile.tokenSet.has(token)) common++;
    }
    if (common === 0) return Number.NEGATIVE_INFINITY;
    if (querySize > 1 && common < 2) return Number.NEGATIVE_INFINITY;

    const precision = common / querySize;
    if (precision < 0.5) return Number.NEGATIVE_INFINITY;

    let versionPenalty = 0;
    if (queryProfile.compositeVersions.size > 0) {
        if (targetProfile.compositeVersions.size > 0) {
            if (!hasIntersection(queryProfile.compositeVersions, targetProfile.compositeVersions)) {
                return Number.NEGATIVE_INFINITY;
            }
        } else if (hasIntersection(queryProfile.majorVersions, targetProfile.majorVersions)) {
            versionPenalty += 3;
        } else {
            return Number.NEGATIVE_INFINITY;
        }
    } else if (queryProfile.majorVersions.size > 0) {
        if (!hasIntersection(queryProfile.majorVersions, targetProfile.majorVersions)) {
            return Number.NEGATIVE_INFINITY;
        }
    }

    let score = (common * 10) + (precision * 5) - (targetProfile.tokenList.length - common);
    if (queryProfile.vendor && targetProfile.vendor && queryProfile.vendor === targetProfile.vendor) {
        score += 2;
    }
    let qualifierPenalty = 0;
    for (const qualifier of targetProfile.qualifiers) {
        if (!queryProfile.qualifiers.has(qualifier)) {
            qualifierPenalty += 1;
        }
    }
    for (const qualifier of queryProfile.qualifiers) {
        if (!targetProfile.qualifiers.has(qualifier)) {
            qualifierPenalty += 5;
        } else {
            score += 2;
        }
    }
    score -= versionPenalty;
    score -= qualifierPenalty * 2;
    if (targetProfile.isFree) {
        score -= 1;
    }
    score += targetProfile.maxCompositeVersion / 1000000;
    return score;
}

function resolveSemanticPriceMatch(lookupCandidates, priceProfiles = openRouterPriceProfiles) {
    let best = null;

    for (const candidate of lookupCandidates) {
        const queryProfile = buildLookupProfile(candidate);
        for (const targetProfile of priceProfiles) {
            const score = semanticMatchScore(queryProfile, targetProfile);
            if (!Number.isFinite(score)) continue;

            const scored = { score, key: targetProfile.modelId };
            if (!best) {
                best = scored;
                continue;
            }

            if (score > best.score) {
                best = scored;
                continue;
            }

            if (score === best.score && scored.key.localeCompare(best.key) < 0) {
                best = scored;
            }
        }
    }

    if (!best) return null;
    return best.key;
}

const openRouterNormalizedPriceLookupMap = buildNormalizedPriceLookupMap(pricing);
const openRouterPriceProfiles = Object.keys(pricing).map(buildLookupProfile);
let manualNormalizedPriceLookupMap = null;
let manualPriceProfiles = null;

/**
 * Sanitize and validate a price object.
 * @param {any} price
 * @returns {{in: number, out: number}|null}
 */
function parsePriceObject(price) {
    if (!price || typeof price !== 'object') return null;
    const input = Number.parseFloat(price.in);
    const output = Number.parseFloat(price.out);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
        return null;
    }
    const cache = price.cache != null && Number.isFinite(Number.parseFloat(price.cache)) && Number.parseFloat(price.cache) >= 0
        ? Number.parseFloat(price.cache)
        : null;
    return { in: input, out: output, cache: cache };
}

/**
 * Resolve model price using exact + normalized matching with manual override priority.
 * @param {string} modelId
 * @returns {{resolved: boolean, in: number|null, out: number|null, source: string|null, matchedModelId: string|null}}
 */
function resolveModelPrice(modelId) {
    const settings = getSettings();
    const manualPrices = settings.modelPrices || {};
    const lookupCandidates = getModelLookupCandidates(modelId);
    if (!manualNormalizedPriceLookupMap) {
        manualNormalizedPriceLookupMap = buildNormalizedPriceLookupMap(manualPrices);
        manualPriceProfiles = Object.keys(manualPrices).map(buildLookupProfile);
    }

    // 1) Manual exact
    if (Object.prototype.hasOwnProperty.call(manualPrices, modelId)) {
        const parsed = parsePriceObject(manualPrices[modelId]);
        if (parsed) {
            return { resolved: true, ...parsed, source: 'manual-exact', matchedModelId: modelId };
        }
    }

    // 2) Manual normalized
    for (const candidate of lookupCandidates) {
        const normalized = normalizeModelIdForLookup(candidate);
        const matched = manualNormalizedPriceLookupMap.get(normalized);
        if (matched) {
            const parsed = parsePriceObject(manualPrices[matched]);
            if (parsed) {
                return { resolved: true, ...parsed, source: 'manual-normalized', matchedModelId: matched };
            }
        }
    }

    // 3) Manual semantic
    const manualSemanticMatch = resolveSemanticPriceMatch(lookupCandidates, manualPriceProfiles || []);
    if (manualSemanticMatch && Object.prototype.hasOwnProperty.call(manualPrices, manualSemanticMatch)) {
        const parsed = parsePriceObject(manualPrices[manualSemanticMatch]);
        if (parsed) {
            return { resolved: true, ...parsed, source: 'manual-semantic', matchedModelId: manualSemanticMatch };
        }
    }

    // 4) Built-in exact
    if (Object.prototype.hasOwnProperty.call(pricing, modelId)) {
        const parsed = parsePriceObject(pricing[modelId]);
        if (parsed) {
            return { resolved: true, ...parsed, source: 'openrouter-exact', matchedModelId: modelId };
        }
    }

    // 5) Built-in normalized
    for (const candidate of lookupCandidates) {
        const normalized = normalizeModelIdForLookup(candidate);
        const matched = openRouterNormalizedPriceLookupMap.get(normalized);
        if (matched) {
            const parsed = parsePriceObject(pricing[matched]);
            if (parsed) {
                return { resolved: true, ...parsed, source: 'openrouter-normalized', matchedModelId: matched };
            }
        }
    }

    // 6) Semantic fallback (token/version aware)
    const semanticMatch = resolveSemanticPriceMatch(lookupCandidates);
    if (semanticMatch && Object.prototype.hasOwnProperty.call(pricing, semanticMatch)) {
        const parsed = parsePriceObject(pricing[semanticMatch]);
        if (parsed) {
            return { resolved: true, ...parsed, source: 'openrouter-semantic', matchedModelId: semanticMatch };
        }
    }

    return { resolved: false, in: null, out: null, source: null, matchedModelId: null };
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
 * @returns {{in: number|null, out: number|null, resolved: boolean, source: string|null, matchedModelId: string|null}}
 */
function getModelPrice(modelId) {
    return resolveModelPrice(modelId);
}

/**
 * Set price settings for a model
 * @param {string} modelId
 * @param {number} priceIn - Price per 1M input tokens
 * @param {number} priceOut - Price per 1M output tokens
 * @param {number|null} [priceCache=null] - Price per 1M cached tokens (optional)
 */
function setModelPrice(modelId, priceIn, priceOut, priceCache = null) {
    const settings = getSettings();
    const normalizePrice = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed) || parsed < 0) return null;
        return parsed < 0.001 ? 0.001 : parsed;
    };
    const normIn = normalizePrice(priceIn);
    const normOut = normalizePrice(priceOut);
    const normCache = normalizePrice(priceCache);

    const priceObj = {
        in: normIn !== null ? normIn : 0,
        out: normOut !== null ? normOut : 0,
    };
    if (normCache !== null) {
        priceObj.cache = normCache;
    }
    settings.modelPrices[modelId] = priceObj;
    manualNormalizedPriceLookupMap = null;
    manualPriceProfiles = null;
    saveSettings();
}

/**
 * Calculate cost for a given token usage and model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelId
 * @param {number} cacheReadTokens
 * @returns {number} Cost in dollars
 */
function calculateCost(inputTokens, outputTokens, modelId, cacheReadTokens = 0) {
    const settings = getSettings();
    const isCacheTracked = settings.trackCache !== false;

    // If cache tracking is disabled, fold cache tokens into regular input tokens
    const effectiveInput = isCacheTracked ? (inputTokens || 0) : ((inputTokens || 0) + (cacheReadTokens || 0));
    const effectiveCache = isCacheTracked ? (cacheReadTokens || 0) : 0;
    const effectiveOutput = outputTokens || 0;

    if (effectiveInput <= 0 && effectiveOutput <= 0 && effectiveCache <= 0) return 0;

    const prices = resolveModelPrice(modelId);
    if (!prices.resolved || prices.in === null || prices.out === null) return 0;

    // Cache price: default to 10% of input price if not specified
    const cachePrice = prices.cache != null ? prices.cache : (prices.in * 0.1);

    const inputCost = (effectiveInput / 1000000) * prices.in;
    const cacheCost = (effectiveCache / 1000000) * cachePrice;
    const outputCost = (effectiveOutput / 1000000) * prices.out;
    return inputCost + cacheCost + outputCost;
}

function calculateStoredOrEstimatedCost(data, modelId) {
    if (!data) return 0;

    const exactCost = Number.isFinite(data.cost) ? data.cost : 0;
    const residualInput = Math.max(0, (data.input || 0) - (data.costedInput || 0));
    const residualOutput = Math.max(0, (data.output || 0) - (data.costedOutput || 0));
    const residualCache = Math.max(0, data.cache_read || 0);
    return exactCost + calculateCost(residualInput, residualOutput, modelId, residualCache);
}

function formatCost(cost) {
    const value = Number(cost) || 0;
    if (value > 0 && value < 0.01) return '<$0.01';
    return `$${value.toFixed(2)}`;
}

function formatPricePerMillion(price) {    const value = Number(price);
    if (!Number.isFinite(value) || value < 0) return null;
    if (value === 0) return '$0/1M';
    if (value >= 100) return `$${value.toFixed(0)}/1M`;
    if (value >= 10) return `$${value.toFixed(1)}/1M`;
    if (value >= 1) return `$${value.toFixed(2)}/1M`;
    if (value >= 0.01) return `$${value.toFixed(3).replace(/\.?0+$/, '')}/1M`;
    return `$${value.toFixed(4).replace(/\.?0+$/, '')}/1M`;
}

function renderInputOutputRows(prefix, data, isCacheActive) {
    data = data || {};
    const input = data.input || 0;
    const cache = data.cache_read || 0;
    const output = data.output || 0;
    const requests = data.messageCount || 0;

    const displayIn = isCacheActive ? input : (input + cache);

    if (isCacheActive) {
        return `
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; background: rgba(0, 0, 0, 0.22); border-radius: 5px; padding: 5px 4px; text-align: center; border: 1px solid rgba(255, 255, 255, 0.04);">
                <div style="min-width: 0;">
                    <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.6; line-height: 1.2; margin-bottom: 2px;" title="非缓存输入 Token (Net Input)">In</div>
                    <div id="token-usage-${prefix}-in" style="font-size: 11px; font-weight: 600; color: var(--SmartThemeBodyColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${formatNumberFull(displayIn)}">${formatNumberAdaptive(displayIn)}</div>
                </div>
                <div style="min-width: 0;">
                    <div style="font-size: 9px; color: #60a5fa; opacity: 0.95; line-height: 1.2; margin-bottom: 2px;" title="命中的提示词缓存 Token (Prompt Cache)">Cache</div>
                    <div id="token-usage-${prefix}-cache" style="font-size: 11px; font-weight: 600; color: #60a5fa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${formatNumberFull(cache)}">${formatNumberAdaptive(cache)}</div>
                </div>
                <div style="min-width: 0;">
                    <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.6; line-height: 1.2; margin-bottom: 2px;" title="模型生成输出 Token (Output)">Out</div>
                    <div id="token-usage-${prefix}-out" style="font-size: 11px; font-weight: 600; color: var(--SmartThemeBodyColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${formatNumberFull(output)}">${formatNumberAdaptive(output)}</div>
                </div>
                <div style="min-width: 0;">
                    <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.6; line-height: 1.2; margin-bottom: 2px;" title="请求次数 (Requests)">Reqs</div>
                    <div id="token-usage-${prefix}-requests" style="font-size: 11px; font-weight: 600; color: var(--SmartThemeBodyColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${formatNumberFull(requests)}">${formatNumberAdaptive(requests)}</div>
                </div>
            </div>
        `;
    } else {
        return `
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; background: rgba(0, 0, 0, 0.22); border-radius: 5px; padding: 5px 8px; text-align: center; border: 1px solid rgba(255, 255, 255, 0.04);">
                <div style="min-width: 0;">
                    <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.6; line-height: 1.2; margin-bottom: 2px;" title="总输入 Token (Total Input)">Input</div>
                    <div id="token-usage-${prefix}-in" style="font-size: 11px; font-weight: 600; color: var(--SmartThemeBodyColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${formatNumberFull(displayIn)}">${formatNumberAdaptive(displayIn)}</div>
                </div>
                <div style="min-width: 0;">
                    <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.6; line-height: 1.2; margin-bottom: 2px;" title="模型生成输出 Token (Output)">Output</div>
                    <div id="token-usage-${prefix}-out" style="font-size: 11px; font-weight: 600; color: var(--SmartThemeBodyColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${formatNumberFull(output)}">${formatNumberAdaptive(output)}</div>
                </div>
                <div style="min-width: 0;">
                    <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.6; line-height: 1.2; margin-bottom: 2px;" title="请求次数 (Requests)">Requests</div>
                    <div id="token-usage-${prefix}-requests" style="font-size: 11px; font-weight: 600; color: var(--SmartThemeBodyColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;" title="${formatNumberFull(requests)}">${formatNumberAdaptive(requests)}</div>
                </div>
            </div>
        `;
    }
}

function renderUsageStatCard(title, prefix, data, cost = '$0.00', isCacheActive = true) {
    data = data || {};
    const input = data.input || 0;
    const cache = data.cache_read || 0;
    const output = data.output || 0;
    const requests = data.messageCount || 0;
    const totalTokens = data.total != null ? data.total : (input + cache + output);
    const totalPrompt = input + cache;

    const hitRate = isCacheActive && totalPrompt > 0 && cache > 0
        ? Math.round((cache / totalPrompt) * 100)
        : null;

    const hitRateBadge = (isCacheActive && hitRate !== null)
        ? `<span style="font-size: 9px; padding: 1px 5px; border-radius: 4px; background: rgba(59, 130, 246, 0.2); color: #60a5fa; font-weight: 600; cursor: help; border: 1px solid rgba(96, 165, 250, 0.35);" title="提示词缓存命中率: ${hitRate}% (命中: ${formatNumberFull(cache)} / 总输入: ${formatNumberFull(totalPrompt)})">${hitRate}% hit</span>`
        : '';

    return `
        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); padding: 7px 10px; box-sizing: border-box;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                    <span style="font-size: 11px; font-weight: 600; color: var(--SmartThemeBodyColor); letter-spacing: 0.2px;">${title}</span>
                    ${hitRateBadge}
                </div>
                <div style="display: flex; align-items: baseline; gap: 5px; flex-shrink: 0;">
                    <span style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.55;" title="Total: ${formatNumberFull(totalTokens)} tokens">${formatNumberAdaptive(totalTokens)} tok ·</span>
                    <span style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">Cost</span>
                    <span id="token-usage-${prefix}-cost" style="font-size: 13px; font-weight: 700; color: var(--SmartThemeBodyColor);" title="${cost}">${cost}</span>
                </div>
            </div>
            ${renderInputOutputRows(prefix, data, isCacheActive)}
        </div>
    `;
}

function renderAllStatCards() {
    const container = $('#token-usage-stats-grid');
    if (container.length === 0) return;

    const stats = getUsageStats();
    const settings = getSettings();
    const isCacheActive = settings.trackCache !== false;

    // Calculate costs
    const allTimeCost = calculateAllTimeCost();
    const now = new Date();
    const currentWeekKey = getWeekKey(now);
    const currentMonthKey = getMonthKey(now);
    const todayKey = getDayKey(now);

    let weekCost = 0;
    let monthCost = 0;
    let todayCost = 0;

    for (const [dayKey, data] of Object.entries(usageRuntime.byDay)) {
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        if (getWeekKey(date) === currentWeekKey && data.models) {
            for (const [mid, modelData] of Object.entries(data.models)) {
                const cost = calculateStoredOrEstimatedCost(modelData, mid);
                weekCost += cost || 0;
                if (dayKey === todayKey) {
                    todayCost += cost || 0;
                }
            }
        }
        if (getMonthKey(date) === currentMonthKey && data.models) {
            for (const [mid, modelData] of Object.entries(data.models)) {
                const cost = calculateStoredOrEstimatedCost(modelData, mid);
                monthCost += cost || 0;
            }
        }
    }

    const cardsHtml = `
        ${renderUsageStatCard('Today', 'today', stats.today, formatCost(todayCost), isCacheActive)}
        ${renderUsageStatCard('This Week', 'week', stats.thisWeek, formatCost(weekCost), isCacheActive)}
        ${renderUsageStatCard('This Month', 'month', stats.thisMonth, formatCost(monthCost), isCacheActive)}
        ${renderUsageStatCard('All Time', 'alltime', stats.allTime, formatCost(allTimeCost), isCacheActive)}
    `;

    container.html(cardsHtml);
}

/**
 * Calculate all-time cost using the byModel aggregation which has precise input/output counts
 */
function calculateAllTimeCost() {
    const byModel = usageRuntime.byModel;
    let total = 0;

    for (const [modelId, data] of Object.entries(byModel)) {
        const cost = calculateStoredOrEstimatedCost(data, modelId);
        total += cost || 0;
    }
    return total;
}

// Chart state
let currentChartRange = 30;
let currentChartView = 'type'; // 'type' | 'model'
let chartData = [];
let tooltip = null;

const TOKEN_TYPE_COLORS = {
    in: '#6366f1',     // Indigo for Net Input
    cache: '#38bdf8',  // Sky blue / cyan for Prompt Cache
    out: '#10b981',    // Emerald for Output
};

// Chart colors - adapted for dark theme
const CHART_COLORS = {
    bar: 'var(--SmartThemeBorderColor)',
    text: 'var(--SmartThemeBodyColor)',
    grid: 'var(--SmartThemeBorderColor)',
    cursor: 'var(--SmartThemeBodyColor)',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

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
        const dayData = byDay[dayKey] || { total: 0, input: 0, output: 0, messageCount: 0, models: {} };

        data.push({
            date: date,
            dayKey: dayKey,
            usage: dayData.total || 0,
            input: dayData.input || 0,
            cache_read: dayData.cache_read || 0,
            output: dayData.output || 0,
            messageCount: dayData.messageCount || 0,
            models: dayData.models || {},
            displayDate: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date),
            fullDate: new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date),
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
        style: 'display: block; max-width: 100%;',
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
            'stroke-dasharray': '4 4',
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            fill: CHART_COLORS.text,
            'font-size': '10',
            'font-family': 'ui-sans-serif, system-ui, sans-serif',
        });
        text.textContent = formatTokens(val);
        textGroup.appendChild(text);
    }

    // Bars
    const totalBarWidth = chartWidth / chartData.length;
    let barWidth = totalBarWidth * 0.8;
    if (barWidth > 40) barWidth = 40;
    const actualGap = totalBarWidth - barWidth;
    const labelInterval = currentChartRange >= 365 ? 30 : currentChartRange >= 90 ? 7 : currentChartRange >= 30 ? 3 : 1;

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
            style: 'cursor: pointer;',
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

        // Draw filled segments
        if (d.usage > 0) {
            const segments = [];

            if (currentChartView === 'type') {
                const settings = getSettings();
                const isCacheActive = settings.trackCache !== false;
                const inTokens = isCacheActive ? (d.input || 0) : ((d.input || 0) + (d.cache_read || 0));
                const cacheTokens = isCacheActive ? (d.cache_read || 0) : 0;
                const outTokens = d.output || 0;

                // Segments from bottom to top: In, Cache, Out
                if (inTokens > 0) segments.push({ tokens: inTokens, color: TOKEN_TYPE_COLORS.in, label: 'In' });
                if (cacheTokens > 0) segments.push({ tokens: cacheTokens, color: TOKEN_TYPE_COLORS.cache, label: 'Cache' });
                if (outTokens > 0) segments.push({ tokens: outTokens, color: TOKEN_TYPE_COLORS.out, label: 'Out' });
            } else {
                // By Model
                if (d.models && Object.keys(d.models).length > 0) {
                    const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
                    const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(b[1]) - getTokens(a[1]));
                    let attributedTotal = 0;
                    for (const [modelId, modelData] of modelEntries) {
                        const tokens = getTokens(modelData);
                        if (tokens > 0) {
                            segments.push({ tokens, color: getModelColor(modelId), label: modelId });
                            attributedTotal += tokens;
                        }
                    }
                    if (d.usage > attributedTotal) {
                        segments.push({ tokens: d.usage - attributedTotal, color: 'rgba(255, 255, 255, 0.25)', label: 'Unattributed' });
                    }
                } else {
                    segments.push({ tokens: d.usage, color: 'rgba(255, 255, 255, 0.25)', label: 'Unattributed' });
                }
            }

            let cumulativeY = barY + h; // Start from bottom
            for (let sIdx = 0; sIdx < segments.length; sIdx++) {
                const seg = segments[sIdx];
                const segmentHeight = (seg.tokens / d.usage) * h;
                const segmentY = cumulativeY - segmentHeight;

                const isBottom = sIdx === 0;
                const isTop = sIdx === segments.length - 1;

                let segmentPath;
                if (segmentHeight < r * 2) {
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                } else if (isTop && isBottom) {
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else if (isTop) {
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else {
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                }

                const segment = createSVGElement('path', {
                    d: segmentPath,
                    fill: seg.color,
                    opacity: '1',
                    'shape-rendering': 'geometricPrecision',
                    'pointer-events': 'none',
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
            'pointer-events': 'none',
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
                'font-family': 'ui-sans-serif, system-ui, sans-serif',
            });
            label.textContent = d.displayDate;
            textGroup.appendChild(label);
        }
    });

    container.appendChild(svg);
    renderChartLegend();
}

/**
 * Render data legend below the chart
 */
function renderChartLegend() {
    const legendEl = document.getElementById('token-usage-chart-legend');
    if (!legendEl) return;

    const settings = getSettings();
    const isCacheActive = settings.trackCache !== false;
    const totalTokens = chartData.reduce((acc, d) => acc + (d.usage || 0), 0);

    let html = '';

    if (currentChartView === 'type') {
        const totalIn = chartData.reduce((acc, d) => acc + (isCacheActive ? (d.input || 0) : ((d.input || 0) + (d.cache_read || 0))), 0);
        const totalCache = isCacheActive ? chartData.reduce((acc, d) => acc + (d.cache_read || 0), 0) : 0;
        const totalOut = chartData.reduce((acc, d) => acc + (d.output || 0), 0);

        const inPct = totalTokens > 0 ? Math.round((totalIn / totalTokens) * 100) : 0;
        const cachePct = totalTokens > 0 ? Math.round((totalCache / totalTokens) * 100) : 0;
        const outPct = totalTokens > 0 ? Math.round((totalOut / totalTokens) * 100) : 0;

        html += `
            <div style="display: flex; align-items: center; gap: 5px; font-size: 10px;" title="非缓存输入: ${formatNumberFull(totalIn)} tokens">
                <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: ${TOKEN_TYPE_COLORS.in}; flex-shrink: 0;"></span>
                <span style="opacity: 0.75;">In (输入)</span>
                <span style="font-weight: 600;">${formatNumberAdaptive(totalIn)}</span>
                <span style="opacity: 0.45;">(${inPct}%)</span>
            </div>
        `;
        if (isCacheActive) {
            html += `
                <div style="display: flex; align-items: center; gap: 5px; font-size: 10px;" title="缓存命中: ${formatNumberFull(totalCache)} tokens">
                    <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: ${TOKEN_TYPE_COLORS.cache}; flex-shrink: 0;"></span>
                    <span style="color: #60a5fa; font-weight: 600;">Cache (缓存)</span>
                    <span style="color: #60a5fa; font-weight: 700;">${formatNumberAdaptive(totalCache)}</span>
                    <span style="color: #60a5fa; opacity: 0.8;">(${cachePct}%)</span>
                </div>
            `;
        }
        html += `
            <div style="display: flex; align-items: center; gap: 5px; font-size: 10px;" title="生成输出: ${formatNumberFull(totalOut)} tokens">
                <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: ${TOKEN_TYPE_COLORS.out}; flex-shrink: 0;"></span>
                <span style="opacity: 0.75;">Out (输出)</span>
                <span style="font-weight: 600;">${formatNumberAdaptive(totalOut)}</span>
                <span style="opacity: 0.45;">(${outPct}%)</span>
            </div>
        `;
    } else {
        // Model mode
        const modelTotals = {};
        for (const d of chartData) {
            if (d.models) {
                for (const [mId, mData] of Object.entries(d.models)) {
                    const t = typeof mData === 'number' ? mData : (mData?.total || 0);
                    modelTotals[mId] = (modelTotals[mId] || 0) + t;
                }
            }
        }
        const sortedModels = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]);
        if (sortedModels.length === 0) {
            html = '<span style="opacity: 0.5; font-size: 10px;">暂无模型数据</span>';
        } else {
            for (const [mId, tokens] of sortedModels) {
                const color = getModelColor(mId);
                const pct = totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
                const shortName = mId.length > 22 ? mId.substring(0, 19) + '...' : mId;
                html += `
                    <div style="display: flex; align-items: center; gap: 5px; font-size: 10px;" title="${mId}: ${formatNumberFull(tokens)} tokens">
                        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: ${color}; flex-shrink: 0;"></span>
                        <span style="max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85;">${shortName}</span>
                        <span style="font-weight: 600;">${formatNumberAdaptive(tokens)}</span>
                        <span style="opacity: 0.45;">(${pct}%)</span>
                    </div>
                `;
            }
        }
    }

    legendEl.innerHTML = html;
}

function showTooltip(d) {
    if (!tooltip) return;

    const isCacheActive = getSettings().trackCache !== false;

    let tooltipCost = 0;
    if (d.models && Object.keys(d.models).length > 0) {
        for (const [modelId, modelData] of Object.entries(d.models)) {
            tooltipCost += calculateStoredOrEstimatedCost(modelData, modelId) || 0;
        }
    }

    // Build model breakdown HTML
    let modelBreakdown = '';
    if (d.models && Object.keys(d.models).length > 0) {
        const getModelTokenBreakdown = (value) => {
            if (typeof value === 'number') {
                return { total: value, input: null, cache_read: null, output: null, messageCount: null };
            }

            const input = Number(value?.input) || 0;
            const cache_read = Number(value?.cache_read) || 0;
            const output = Number(value?.output) || 0;
            const total = Number(value?.total) || (input + cache_read + output);
            const messageCount = Number(value?.messageCount);
            return { total, input, cache_read, output, messageCount: Number.isFinite(messageCount) ? messageCount : null };
        };

        const modelEntries = Object.entries(d.models).sort((a, b) => getModelTokenBreakdown(a[1]).total - getModelTokenBreakdown(b[1]).total); // Sort ascending (smallest first, like graph bottom-up)
        modelBreakdown = '<div style="margin-top: 2px; padding-top: 3px; border-top: 1px solid rgba(255,255,255,0.2);">';
        const hiddenEntryCount = Math.max(0, modelEntries.length - 8);
        const displayEntries = modelEntries.slice(-8); // Show last 8 (the largest)
        if (hiddenEntryCount > 0) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3); margin-bottom: 2px;">+${hiddenEntryCount} more</div>`;
        }
        for (const [model, modelData] of displayEntries) {
            const { total, input, cache_read, output, messageCount } = getModelTokenBreakdown(modelData);
            const percent = d.usage > 0 ? Math.round((total / d.usage) * 100) : 0;
            const shortName = model.length > 25 ? model.substring(0, 22) + '...' : model;
            const color = getModelColor(model);

            let breakdownText = '';
            if (input !== null && output !== null) {
                if (isCacheActive) {
                    const hit = (input + cache_read) > 0 && cache_read > 0 ? ` (${Math.round(cache_read / (input + cache_read) * 100)}% hit)` : '';
                    breakdownText = `${formatNumberFull(input)} in${cache_read ? ` | ${formatNumberFull(cache_read)} cache${hit}` : ''} | ${formatNumberFull(output)} out${messageCount !== null ? ` | ${formatNumberFull(messageCount)} reqs` : ''}`;
                } else {
                    breakdownText = `${formatNumberFull(input + cache_read)} in | ${formatNumberFull(output)} out${messageCount !== null ? ` | ${formatNumberFull(messageCount)} reqs` : ''}`;
                }
            } else {
                breakdownText = `Total: ${formatNumberFull(total)}`;
            }

            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); margin-bottom: 2px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                    <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                        <span style="display: inline-block; width: 7px; height: 7px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                    </div>
                    <span style="flex-shrink: 0;">${percent}%</span>
                </div>
                <div style="margin-top: 0; margin-left: 12px; color: rgba(255,255,255,0.65); line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${breakdownText}
                </div>
            </div>`;
        }
        modelBreakdown += '</div>';
    }

    const gridHtml = isCacheActive
        ? `
            <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px 6px; font-size: 10px; color: var(--SmartThemeBodyColor); margin-bottom: 2px;">
                <div style="opacity: 0.6;">In</div>
                <div style="opacity: 0.6; color: #60a5fa;" title="Prompt Cache Tokens">Cache</div>
                <div style="opacity: 0.6;">Out</div>
                <div style="opacity: 0.6;">Requests</div>
                <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.input)}</div>
                <div style="font-size: 11px; font-weight: 600; color: #60a5fa;">${formatNumberFull(d.cache_read || 0)}</div>
                <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.output)}</div>
                <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.messageCount)}</div>
            </div>
        `
        : `
            <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px 8px; font-size: 10px; color: var(--SmartThemeBodyColor); margin-bottom: 2px;">
                <div style="opacity: 0.6;">In</div>
                <div style="opacity: 0.6;">Out</div>
                <div style="opacity: 0.6;">Requests</div>
                <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.input + (d.cache_read || 0))}</div>
                <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.output)}</div>
                <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.messageCount)}</div>
            </div>
        `;

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="font-size: 12px; font-weight: 600; color: var(--SmartThemeBodyColor); margin-bottom: 4px;">${formatCost(tooltipCost)}</div>
        ${gridHtml}
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

function updateChartView(view) {
    currentChartView = view;
    document.querySelectorAll('.token-usage-view-btn').forEach(btn => {
        const val = btn.getAttribute('data-view');
        if (val === view) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    renderChart();
}

/**
 * Update the stats display in the UI
 */
function updateUIStats() {
    renderAllStatCards();

    const stats = getUsageStats();
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
    const settings = getSettings();
    const isCacheActive = settings.trackCache !== false;

    if (models.length === 0) {
        grid.empty().append('<div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.5; padding: 8px; text-align: center;">No models tracked yet</div>');
        return;
    }

    const currentMode = grid.attr('data-cache-mode');
    const expectedMode = isCacheActive ? 'cache' : 'nocache';
    const existingRows = grid.children('.model-config-row');
    if (existingRows.length === models.length && currentMode === expectedMode) {
        return;
    }

    grid.empty();
    grid.attr('data-cache-mode', expectedMode);

    const formatPriceForInput = (value) => {
        if (value === null || value === undefined || Number.isNaN(value)) return '';
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return '';
        if (numeric > 0 && numeric < 0.001) return '0.001';
        const rounded = numeric.toFixed(3);
        if (numeric > 0 && rounded === '0.000') return '0.001';
        return rounded.replace(/\.?0+$/, '');
    };

    for (const model of models) {
        const color = getModelColor(model);
        const prices = getModelPrice(model);
        const inputValue = formatPriceForInput(prices.in);
        const cacheValue = formatPriceForInput(prices.cache);
        const outputValue = formatPriceForInput(prices.out);

        const cacheInputHtml = isCacheActive ? `
            <input type="number" class="price-input-cache" data-model="${model}" value="${cacheValue}" step="0.001" min="0" placeholder="Cache" title="Price per 1M cached tokens (default: 10% of In)" style="width: 36px; padding: 1px 2px; font-size: 8px; border-radius: 2px; border: 1px solid rgba(96, 165, 250, 0.4); background: var(--SmartThemeInputColor); color: #60a5fa; flex-shrink: 0; text-align: center;">
        ` : '';

        const row = $(`
            <div class="model-config-row" style="display: flex; align-items: center; gap: 4px; min-width: 0; padding: 2px 0;">
                <input type="color" value="${color}" data-model="${model}"
                       class="model-color-picker"
                       style="width: 18px; height: 18px; padding: 0; border: none; cursor: pointer; flex-shrink: 0; border-radius: 3px;">
                <span title="${model}" style="font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--SmartThemeBodyColor); flex: 1;">${model}</span>
                <span style="font-size: 8px; color: var(--SmartThemeBodyColor); opacity: 0.5; flex-shrink: 0;">Price</span>
                <input type="number" class="price-input-in" data-model="${model}" value="${inputValue}" step="0.001" min="0" placeholder="In" title="Price per 1M input tokens" style="width: 36px; padding: 1px 2px; font-size: 8px; border-radius: 2px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); flex-shrink: 0; text-align: center;">
                ${cacheInputHtml}
                <input type="number" class="price-input-out" data-model="${model}" value="${outputValue}" step="0.001" min="0" placeholder="Out" title="Price per 1M output tokens" style="width: 36px; padding: 1px 2px; font-size: 8px; border-radius: 2px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); flex-shrink: 0; text-align: center;">
            </div>
        `);

        // Color picker handler
        row.find('.model-color-picker').on('change', function () {
            setModelColor(String($(this).data('model')), String($(this).val()));
            renderChart();
        });

        // Price input handlers with debounce
        let debounceTimer;
        const handlePriceChange = () => {
            const mId = model; // closure
            const pIn = row.find('.price-input-in').val();
            const pCache = isCacheActive ? row.find('.price-input-cache').val() : null;
            const pOut = row.find('.price-input-out').val();
            setModelPrice(mId, pIn, pOut, pCache);
            // Trigger UI update to recalc costs
            updateUIStats();
        };

        row.find('input[type="number"]').on('input', function () {
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
    const stats = getUsageStats();
    const settings = getSettings();
    const isCacheActive = settings.trackCache !== false;

    const html = `
        <div id="token_usage_tracker_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Usage Tracker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <!-- Chart -->
                    <div class="token-usage-chart-shell" style="margin-bottom: 12px;">
                        <div class="token-usage-chart-toolbar" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 4px;">
                            <div class="token-usage-view-controls" style="display: inline-flex; gap: 2px;">
                                <button class="token-usage-view-btn menu_button active" data-view="type" style="padding: 2px 8px; font-size: 10px; border-radius: 4px;" title="按输入/缓存/输出类型统计">按类型</button>
                                <button class="token-usage-view-btn menu_button" data-view="model" style="padding: 2px 8px; font-size: 10px; border-radius: 4px;" title="按模型统计">按模型</button>
                            </div>
                            <div class="token-usage-range-controls" style="display: inline-flex; gap: 2px;">
                                <button class="token-usage-range-btn menu_button" data-value="7" style="padding: 2px 8px; font-size: 10px; border-radius: 4px;">7D</button>
                                <button class="token-usage-range-btn menu_button active" data-value="30" style="padding: 2px 8px; font-size: 10px; border-radius: 4px;">30D</button>
                                <button class="token-usage-range-btn menu_button" data-value="90" style="padding: 2px 8px; font-size: 10px; border-radius: 4px;">90D</button>
                                <button class="token-usage-range-btn menu_button" data-value="365" style="padding: 2px 8px; font-size: 10px; border-radius: 4px;">365D</button>
                            </div>
                        </div>
                        <div id="token-usage-chart" style="width: 100%; height: 260px; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; overflow: hidden;"></div>
                        <div id="token-usage-chart-legend" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px 12px; margin-top: 6px; padding: 6px 8px; font-size: 10px; color: var(--SmartThemeBodyColor); background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor);"></div>
                    </div>

                    <!-- Stats Grid (Today, Week, Month, All Time) -->
                    <div id="token-usage-stats-grid" class="token-usage-stats-grid" style="display: grid; grid-template-columns: 1fr; gap: 6px; margin-bottom: 10px;">
                        ${renderUsageStatCard('Today', 'today', stats.today, '$0.00', isCacheActive)}
                        ${renderUsageStatCard('This Week', 'week', stats.thisWeek, '$0.00', isCacheActive)}
                        ${renderUsageStatCard('This Month', 'month', stats.thisMonth, '$0.00', isCacheActive)}
                        ${renderUsageStatCard('All Time', 'alltime', stats.allTime, '$0.00', isCacheActive)}
                    </div>

                    <!-- Config (Model Colors & Prices) -->
                    <div class="inline-drawer" style="margin-top: 10px;">
                        <div class="inline-drawer-toggle inline-drawer-header" style="padding: 4px 0 4px 8px;">
                            <span style="font-size: 11px;">Config</span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content">
                            <div id="token-usage-model-colors-grid" style="display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; padding-right: 2px;"></div>
                        </div>
                    </div>

                    <!-- Prompt Cache Settings -->
                    <div class="inline-drawer" style="margin-top: 6px;">
                        <div class="inline-drawer-toggle inline-drawer-header" style="padding: 4px 0 4px 8px;">
                            <span style="font-size: 11px;">Prompt Cache (提示词缓存)</span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content" style="padding: 6px 8px; font-size: 11px;">
                            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; cursor: pointer; font-weight: 600;">
                                <input type="checkbox" id="token-usage-track-cache">
                                <span>按缓存统计 (Track Prompt Cache)</span>
                            </label>
                            <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.65; margin-bottom: 8px; line-height: 1.35;">
                                开启后在卡片中独立显示 Cache 命中及费率；关闭后所有缓存 Token 合并为输入统计。
                            </div>
                            <div id="token-usage-cache-sub-options" style="border-top: 1px dashed var(--SmartThemeBorderColor); padding-top: 6px;">
                                <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; cursor: pointer;">
                                    <input type="checkbox" id="token-usage-cache-sim-enabled">
                                    <span>中转未返时推算缓存 (Infer Cache)</span>
                                </label>
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.55; margin-bottom: 6px;">
                                    当中转代理未返回 cached_tokens 时，自动根据前缀与时间差模拟推算。
                                </div>
                                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                                    <label style="display: flex; align-items: center; gap: 4px;">
                                        <span style="opacity: 0.7;">Min Tokens:</span>
                                        <input type="number" id="token-usage-cache-min-tokens" min="0" step="64" style="width: 55px; padding: 2px 4px; font-size: 10px; border-radius: 3px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor);">
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 4px;">
                                        <span style="opacity: 0.7;">TTL (min):</span>
                                        <input type="number" id="token-usage-cache-ttl-min" min="0" step="1" style="width: 45px; padding: 2px 4px; font-size: 10px; border-radius: 3px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor);">
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Controls -->
                    <div style="display: flex; align-items: center; gap: 8px; padding-left: 8px; margin-top: 8px;">
                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;" id="token-usage-tokenizer">Tokenizer: ${stats.tokenizer || 'Unknown'}</div>
                        <div style="flex: 1;"></div>
                        <div id="token-usage-export" class="menu_button" title="Download all usage data as CSV" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-download"></i>&nbsp;Export
                        </div>
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

    // Initialize Prompt Cache settings inputs
    if (!settings.cacheSimulation) settings.cacheSimulation = structuredClone(defaultSettings.cacheSimulation);
    const isCacheTracked = settings.trackCache !== false;
    $('#token-usage-track-cache').prop('checked', isCacheTracked);
    if (!isCacheTracked) {
        $('#token-usage-cache-sub-options').hide();
    } else {
        $('#token-usage-cache-sub-options').show();
    }

    $('#token-usage-track-cache').on('change', function () {
        const checked = $(this).is(':checked');
        settings.trackCache = checked;
        saveSettings();
        if (checked) {
            $('#token-usage-cache-sub-options').slideDown(150);
        } else {
            $('#token-usage-cache-sub-options').slideUp(150);
        }
        $('#token-usage-model-colors-grid').removeAttr('data-cache-mode');
        updateUIStats();
    });

    $('#token-usage-cache-sim-enabled').prop('checked', settings.cacheSimulation.enabled !== false);
    $('#token-usage-cache-min-tokens').val(settings.cacheSimulation.minThreshold ?? 1024);
    $('#token-usage-cache-ttl-min').val(settings.cacheSimulation.ttlMinutes ?? 10);

    $('#token-usage-cache-sim-enabled').on('change', function () {
        settings.cacheSimulation.enabled = $(this).is(':checked');
        saveSettings();
    });
    $('#token-usage-cache-min-tokens').on('input', function () {
        settings.cacheSimulation.minThreshold = Math.max(0, parseInt($(this).val(), 10) || 0);
        saveSettings();
    });
    $('#token-usage-cache-ttl-min').on('input', function () {
        settings.cacheSimulation.ttlMinutes = Math.max(0, parseInt($(this).val(), 10) || 0);
        saveSettings();
    });

    // Create tooltip element and append to body (not inside extension container to avoid layout issues)
    if (!document.getElementById('token-usage-tooltip')) {
        const tooltipEl = document.createElement('div');
        tooltipEl.id = 'token-usage-tooltip';
        tooltipEl.style.cssText = 'position: fixed; display: none; background: rgba(0,0,0,0.9); color: white; padding: 6px 10px; border-radius: 6px; font-size: 11px; pointer-events: none; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
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

    // View button handlers
    document.querySelectorAll('.token-usage-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            updateChartView(btn.getAttribute('data-view'));
        });
    });

    $('#token-usage-export').on('click', exportUsageCsv);

    $('#token-usage-reset-all').on('click', function () {
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
    patchGenerateQuietPrompt();
    patchConnectionManager();
}

function patchGenerateQuietPrompt() {
    // For quiet generations (Guided Generations, Summarize, Expressions, etc.),
    // MESSAGE_RECEIVED doesn't fire. Flush pending tokens on next generation or chat change.
    eventSource.on(event_types.GENERATION_STARTED, async (type, params, dryRun) => {
        if (dryRun) return;
        if (isQuietGeneration && pendingInputTokensPromise) {
            await flushQuietGeneration();
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (isQuietGeneration && pendingInputTokensPromise) {
            await flushQuietGeneration();
        }
    });
}

/**
 * Flush a pending quiet generation, recording tokens from what we have
 */
async function flushQuietGeneration() {
    if (!pendingInputTokensPromise) return;

    try {
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;

        // Try to get output from streaming processor
        let outputTokens = 0;
        if (streamingProcessor?.result) {
            outputTokens = await countTokens(streamingProcessor.result);
        }

        // Record the usage
        if (inputTokens > 0 || outputTokens > 0) {
            recordUsage(inputTokens, outputTokens, null, modelId);
        }
    } catch (e) {
        console.error('[Token Usage Tracker] Error flushing quiet generation:', e);
    } finally {
        // Reset state
        pendingInputTokensPromise = null;
        pendingModelId = null;
        isQuietGeneration = false;
    }
}

function patchConnectionManager() {
    // Poll for ConnectionManagerRequestService (used by Roadway and similar extensions)
    const checkInterval = setInterval(() => {
        try {
            const context = getContext();
            const ServiceClass = context?.ConnectionManagerRequestService;

            if (!ServiceClass || typeof ServiceClass.sendRequest !== 'function') return;
            if (ServiceClass.sendRequest._isPatched) {
                clearInterval(checkInterval);
                return;
            }

            const originalSendRequest = ServiceClass.sendRequest.bind(ServiceClass);

            ServiceClass.sendRequest = async function(profileId, messages, maxTokens, custom, overridePayload) {
                if (isTrackingBackground) {
                    return await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);
                }

                let inputTokens = 0;
                const modelId = getGeneratingModel();

                try {
                    isTrackingBackground = true;

                    try {
                        inputTokens = await countInputTokens({ prompt: messages });
                    } catch (e) {
                        console.error('[Token Usage Tracker] Error counting sendRequest input:', e);
                    }

                    const result = await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);

                    try {
                        let outputTokens = 0;
                        if (result && typeof result.content === 'string') {
                            outputTokens = await countTokens(result.content);
                        } else if (typeof result === 'string') {
                            outputTokens = await countTokens(result);
                        }

                        if (outputTokens > 0 || inputTokens > 0) {
                            recordUsage(inputTokens, outputTokens, null, modelId);
                        }
                    } catch (e) {
                        console.error('[Token Usage Tracker] Error counting sendRequest output:', e);
                    }

                    return result;
                } finally {
                    isTrackingBackground = false;
                }
            };

            ServiceClass.sendRequest._isPatched = true;
            clearInterval(checkInterval);
        } catch (e) {
            console.error('[Token Usage Tracker] Error in patchConnectionManager:', e);
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
    const modelId = getGeneratingModel();

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
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);

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
