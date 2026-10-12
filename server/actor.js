'use strict';

/**
 * Work's client for OpenVibe.Actor: POST /api/v1/tasks with Work's own service token (audience openvibe.actor,
 * capability actor.task.create) and the person in X-OV-Subject, exactly as OpenVibe.Watch does. The task's own
 * Idempotency-Key is passed in the body, so the request is not retried here: a refusal or outage is the route's to
 * answer (server/http/api.js maps it to 503 work.actor_unavailable, or passes through Actor's 402/429).
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

function create({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    // Off without Actor's URL or without Work's own OAuth client (development has neither secret nor service token).
    const available = Boolean(config && config.actor && config.actor.url && config.oauth && config.oauth.clientId && config.oauth.clientSecret);
    if (!available) {
        return {
            available: false,
            async createTask() { throw new Error('OpenVibe.Actor is not configured'); },
        };
    }
    const client = createClient({
        fetch: fetchImpl,
        baseUrls: { actor: config.actor.url },
        tokenProvider: createServiceTokenClient({ network: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl }),
        retries: 0,
        timeoutMs: config.actor.timeoutMs || 15000,
        onWarning: (msg) => log.warn(`[OpenVibe.Work] ${msg}`),
    });
    return {
        available: true,
        /** subjectId is usr_…; returns { id, state } on success, or throws an OpenVibeError. */
        async createTask({ subjectId, task, idempotencyKey }) {
            return client.json({
                service: 'actor', baseUrl: config.actor.url, audience: 'openvibe.actor',
                method: 'POST', path: '/api/v1/tasks',
                headers: { 'X-OV-Subject': subjectId },
                json: { task, idempotency_key: idempotencyKey },
                retries: 0, idempotencyKey: false,
            });
        },
    };
}

module.exports = { create };
