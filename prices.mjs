#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPENROUTER_MODELS_API = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_EFFECTIVE_PRICING_API = 'https://openrouter.ai/api/frontend/v1/stats/effective-pricing';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DICT_FILE = path.join(__dirname, 'dict.js');
const OUTPUT_REPORT_FILE = path.join(__dirname, 'prices.json');
const CONCURRENCY = 8;
const RETRIES = 3;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, retries = RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            return await res.json();
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                await sleep(250 * (2 ** attempt));
            }
        }
    }
    throw lastError;
}

async function mapLimit(items, limit, iterator) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const current = nextIndex;
            nextIndex++;
            if (current >= items.length) return;
            results[current] = await iterator(items[current], current);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

function round6(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}

async function main() {
    const modelsPayload = await fetchJsonWithRetry(OPENROUTER_MODELS_API);
    const models = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];
    const modelIds = models.map(m => m?.id).filter(Boolean);

    const entries = await mapLimit(modelIds, CONCURRENCY, async (modelId) => {
        const model = models.find(item => item?.id === modelId);
        const permaslug = model?.canonical_slug || modelId;
        const url = new URL(OPENROUTER_EFFECTIVE_PRICING_API);
        url.searchParams.set('permaslug', permaslug);
        url.searchParams.set('range', '3m');
        url.searchParams.set('shape', 'v7');
        url.searchParams.set('variant', 'standard');

        try {
            const payload = await fetchJsonWithRetry(url.toString());
            const data = payload?.data || {};
            const weightedInputPrice = Number(data?.weightedInputPrice);
            const weightedOutputPrice = Number(data?.weightedOutputPrice);
            const providerSummaries = Array.isArray(data?.providerSummaries) ? data.providerSummaries : [];
            const hasValidNumbers = Number.isFinite(weightedInputPrice) && Number.isFinite(weightedOutputPrice);
            const resolved = hasValidNumbers && (providerSummaries.length > 0 || weightedInputPrice > 0 || weightedOutputPrice > 0);

            return {
                modelId,
                permaslug,
                resolved,
                // Effective pricing is already reported per 1M tokens.
                in: hasValidNumbers ? round6(weightedInputPrice) : null,
                out: hasValidNumbers ? round6(weightedOutputPrice) : null,
                providers: providerSummaries.length,
                error: null,
            };
        } catch (error) {
            return {
                modelId,
                permaslug,
                resolved: false,
                in: null,
                out: null,
                providers: 0,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });

    const pricing = {};
    const unresolved = [];

    for (const row of entries) {
        if (row.resolved && row.in !== null && row.out !== null) {
            pricing[row.modelId] = { in: row.in, out: row.out };
        } else {
            unresolved.push({
                modelId: row.modelId,
                permaslug: row.permaslug,
                providers: row.providers,
                in: row.in,
                out: row.out,
                error: row.error,
            });
        }
    }

    const dictSource = `export const pricing = ${JSON.stringify(pricing, null, 4)};\n`;
    await fs.writeFile(OUTPUT_DICT_FILE, dictSource, 'utf8');

    const report = {
        generatedAt: new Date().toISOString(),
        requestedModels: modelIds.length,
        resolvedModels: Object.keys(pricing).length,
        unresolvedModels: unresolved.length,
        unresolved,
    };
    await fs.writeFile(OUTPUT_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(`Requested models: ${report.requestedModels}`);
    console.log(`Resolved prices: ${report.resolvedModels}`);
    console.log(`Unresolved: ${report.unresolvedModels}`);
    console.log(`Wrote dict: ${OUTPUT_DICT_FILE}`);
    console.log(`Wrote report: ${OUTPUT_REPORT_FILE}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
