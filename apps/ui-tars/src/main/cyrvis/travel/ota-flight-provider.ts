/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { FlightOffer, FlightSearchInput } from './travel-flight';
import { resolveCityIata } from './flight-provider';

export interface OtaSourceStatus {
  ok: boolean;
  count: number;
  error?: string | null;
}

export interface OtaFlightSearchResult {
  offers: FlightOffer[];
  sources: {
    ctrip: OtaSourceStatus;
    trip: OtaSourceStatus;
  };
}

interface WorkerOffer {
  id?: string;
  source?: string;
  sourceLabel?: string;
  airline?: string;
  flightNo?: string;
  price?: number;
  currency?: string;
  departure?: string;
  arrival?: string;
  durationMinutes?: number;
  stops?: number;
  direct?: boolean;
  url?: string;
}

interface WorkerResponse {
  ok?: boolean;
  error?: string;
  sources?: OtaFlightSearchResult['sources'];
  offers?: WorkerOffer[];
}

const WORKER_CANDIDATES = (): string[] => [
  ...(process.env.CYRVIS_OTA_WORKER ? [process.env.CYRVIS_OTA_WORKER] : []),
  path.resolve(process.cwd(), 'resources', 'cyrvis', 'ota-flight-worker.cjs'),
  path.resolve(
    process.cwd(),
    '..',
    '..',
    'resources',
    'cyrvis',
    'ota-flight-worker.cjs',
  ),
  ...(process.resourcesPath
    ? [path.join(process.resourcesPath, 'cyrvis', 'ota-flight-worker.cjs')]
    : []),
];

const findWorker = (): string | null =>
  WORKER_CANDIDATES().find((candidate) => fs.existsSync(candidate)) ?? null;

const runWorker = (
  node: string,
  worker: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(node, [worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CYRVIS_OTA_HEADLESS: process.env.CYRVIS_OTA_HEADLESS || '0',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try {
          child.kill();
        } catch {
          // already exited
        }
        reject(error);
      } else {
        resolve(value || '');
      }
    };
    const timer = setTimeout(
      () => finish(new Error('ota_worker_timeout')),
      timeoutMs,
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(
          new Error(`ota_worker_exit_${code}:${stderr.trim().slice(0, 500)}`),
        );
        return;
      }
      finish(null, stdout);
    });
    child.stdin.end(JSON.stringify(request));
  });

// Avoid hammering the OTA sites: one attempt per route/date per minute.
const cache = new Map<string, { at: number; result: OtaFlightSearchResult }>();
const CACHE_MS = 60_000;

const toOffers = (raw: WorkerOffer[]): FlightOffer[] =>
  raw
    .filter(
      (offer) =>
        typeof offer.price === 'number' &&
        Number.isFinite(offer.price) &&
        offer.price > 0,
    )
    .map((offer, index) => {
      const sourceLabel = offer.sourceLabel || offer.source || 'OTA';
      const airline = offer.airline || '航班';
      const price = Math.round(Number(offer.price));
      const stops =
        typeof offer.stops === 'number' && offer.stops >= 0
          ? offer.stops
          : offer.direct
            ? 0
            : 1;
      return {
        id:
          offer.id ||
          `${offer.source || 'ota'}-${index}-${offer.flightNo || airline}-${price}`,
        providerId: offer.source || 'ota',
        provider: airline,
        title: `${sourceLabel} ${airline}${
          offer.flightNo ? ` ${offer.flightNo}` : ''
        } ${offer.departure || ''}-${offer.arrival || ''}`,
        totalPrice: price,
        currency: offer.currency || 'CNY',
        url: offer.url || '',
        conditions: {
          direct: stops === 0,
          transferCount: stops,
          baggageKg: 0,
          refundable: false,
          departureTime: offer.departure,
          arrivalTime: offer.arrival,
          durationMinutes: offer.durationMinutes,
        },
        departTime: offer.departure || '',
        metadata: {
          live: true,
          source: offer.source || 'ota',
          sourceLabel,
          flightNo: offer.flightNo,
          stops,
          demo: false,
        },
      };
    });

/**
 * Best-effort Ctrip + Trip.com scrape. The worker launches a visible Chrome,
 * makes one attempt per site, and reports per-source availability. The caller
 * must treat missing sources as unavailable, never as zero-price offers.
 */
export interface FocusOtaRequest {
  source: 'ctrip' | 'trip';
  origin: string;
  destination: string;
  date: string;
  flightNo?: string;
  airline?: string;
  price?: number;
}

const FOCUS_WORKER_CANDIDATES = (): string[] => [
  ...(process.env.CYRVIS_OTA_FOCUS_WORKER
    ? [process.env.CYRVIS_OTA_FOCUS_WORKER]
    : []),
  path.resolve(process.cwd(), 'resources', 'cyrvis', 'ota-focus-worker.cjs'),
  path.resolve(
    process.cwd(),
    '..',
    '..',
    'resources',
    'cyrvis',
    'ota-focus-worker.cjs',
  ),
  ...(process.resourcesPath
    ? [path.join(process.resourcesPath, 'cyrvis', 'ota-focus-worker.cjs')]
    : []),
];

/**
 * Detached, best-effort: open the winning OTA flight in the logged-in
 * persistent Chrome and leave it on the fare/checkout page. The normal
 * `openExternal(best.url)` remains the immediate fallback.
 */
export const focusOtaOffer = (request: FocusOtaRequest): boolean => {
  if (process.env.CYRVIS_OTA_ENABLED === '0') return false;
  const origin = resolveCityIata(request.origin);
  const destination = resolveCityIata(request.destination);
  if (!origin || !destination) return false;
  const worker = FOCUS_WORKER_CANDIDATES().find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!worker) return false;
  const node = process.env.CYRVIS_NODE?.trim() || 'node';
  try {
    const child = spawn(
      node,
      [
        worker,
        JSON.stringify({
          source: request.source,
          origin,
          destination,
          date: request.date,
          flightNo: request.flightNo,
          airline: request.airline,
          price: request.price,
        }),
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: process.env,
      },
    );
    child.unref();
    return true;
  } catch (error) {
    console.warn('[cyrvis travel] focus worker spawn failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

export const searchOtaFlights = async (
  input: FlightSearchInput,
): Promise<OtaFlightSearchResult> => {
  const emptyWith = (error: string): OtaFlightSearchResult => ({
    offers: [],
    sources: {
      ctrip: { ok: false, count: 0, error },
      trip: { ok: false, count: 0, error },
    },
  });
  if (process.env.CYRVIS_OTA_ENABLED === '0') {
    return emptyWith('disabled_by_env');
  }
  // The worker only supports one-way searches.
  if (input.durationDays && input.durationDays > 0) {
    return emptyWith('round_trip_not_supported');
  }

  const origin = resolveCityIata(input.origin);
  const destination = resolveCityIata(input.destination);
  if (!origin || !destination) {
    return emptyWith('unsupported_city');
  }

  const key = `${origin}|${destination}|${input.departDate}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.result;
  }

  const worker = findWorker();
  if (!worker) {
    throw new Error('ota_worker_not_found');
  }
  const node = process.env.CYRVIS_NODE?.trim() || 'node';
  const stdout = await runWorker(
    node,
    worker,
    { origin, destination, date: input.departDate },
    65_000,
  );
  let response: WorkerResponse;
  try {
    response = JSON.parse(stdout) as WorkerResponse;
  } catch {
    throw new Error('ota_worker_invalid_json');
  }
  const result: OtaFlightSearchResult = {
    offers: toOffers(response.offers || []),
    sources: response.sources || {
      ctrip: { ok: false, count: 0, error: response.error || 'unknown' },
      trip: { ok: false, count: 0, error: response.error || 'unknown' },
    },
  };
  cache.set(key, { at: Date.now(), result });
  return result;
};
