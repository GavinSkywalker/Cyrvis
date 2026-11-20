/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  DEFAULT_RANK_WEIGHTS,
  type Offer,
  type RankResult,
  type RankWeights,
  type RankedOffer,
} from './types';

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const timeScore = (value?: string): number => {
  if (!value) return 0.5;
  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) return 0.5;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  // Prefer daytime departures and avoid 00:00-06:00 red-eyes.
  if (minutes >= 7 * 60 && minutes <= 21 * 60) return 1;
  if (minutes >= 6 * 60 && minutes < 7 * 60) return 0.7;
  return 0.35;
};

const reasonFor = (offer: Offer, minPrice: number): string[] => {
  const reasons: string[] = [];
  if (offer.totalPrice <= minPrice) reasons.push('总价最低');
  if (offer.conditions.direct) reasons.push('直飞');
  if ((offer.conditions.baggageKg || 0) > 0) {
    reasons.push(`含 ${offer.conditions.baggageKg}kg 行李`);
  }
  if (offer.conditions.refundable) reasons.push('可退改');
  if (offer.conditions.transferCount && offer.conditions.transferCount > 0) {
    reasons.push(`中转 ${offer.conditions.transferCount} 次`);
  }
  return reasons;
};

/**
 * Generic multi-provider offer ranker.
 *
 * Flights are the first consumer, but the same scoring works for hotels,
 * shopping, tickets and any other normalized Offer list.
 */
export const rankOffers = (
  offers: Offer[],
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
): RankResult => {
  const usable = offers.filter(
    (offer) => Number.isFinite(offer.totalPrice) && offer.totalPrice > 0,
  );
  if (!usable.length) return { ranked: [], best: null, reasons: [] };

  const prices = usable.map((offer) => offer.totalPrice);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceSpan = Math.max(1, maxPrice - minPrice);
  const maxBaggage = Math.max(
    1,
    ...usable.map((offer) => offer.conditions.baggageKg || 0),
  );
  const durations = usable
    .map((offer) => offer.conditions.durationMinutes)
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value > 0,
    );
  const minDuration = durations.length ? Math.min(...durations) : 0;
  const maxDuration = durations.length ? Math.max(...durations) : 0;
  const durationSpan = Math.max(1, maxDuration - minDuration);

  const ranked: RankedOffer[] = usable.map((offer) => {
    const priceScore = 1 - (offer.totalPrice - minPrice) / priceSpan;
    const directScore = offer.conditions.direct ? 1 : 0;
    const baggageScore = clamp01(
      (offer.conditions.baggageKg || 0) / maxBaggage,
    );
    const refundScore = offer.conditions.refundable ? 1 : 0;
    const convenienceScore = timeScore(offer.conditions.departureTime);
    const durationScore =
      typeof offer.conditions.durationMinutes === 'number' && durations.length
        ? 1 - (offer.conditions.durationMinutes - minDuration) / durationSpan
        : 0;
    const score =
      clamp01(priceScore) * weights.price +
      directScore * weights.direct +
      baggageScore * weights.baggage +
      refundScore * weights.refundable +
      convenienceScore * weights.convenience +
      clamp01(durationScore) * (weights.duration || 0);

    return {
      ...offer,
      score: Number(score.toFixed(4)),
      reasons: reasonFor(offer, minPrice).slice(0, 3),
    };
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.totalPrice - b.totalPrice ||
      a.provider.localeCompare(b.provider),
  );

  const best = ranked[0];
  const reasons = best.reasons.length
    ? [...best.reasons]
    : ['综合价格和条件最优'];
  if (best && ranked[1] && best.totalPrice < ranked[1].totalPrice) {
    const cheapestIndex = reasons.indexOf('总价最低');
    if (cheapestIndex >= 0) reasons.splice(cheapestIndex, 1);
    reasons.unshift(
      `比第二名便宜 ${ranked[1].totalPrice - best.totalPrice} 元`,
    );
  }
  return {
    ranked,
    best,
    reasons: [...new Set(reasons)].slice(0, 3),
  };
};
