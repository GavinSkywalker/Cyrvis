/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OfferConditions {
  direct?: boolean;
  baggageKg?: number;
  refundable?: boolean;
  transferCount?: number;
  departureTime?: string;
  arrivalTime?: string;
  /** Total itinerary duration in minutes, when the provider supplies it. */
  durationMinutes?: number;
}

export interface Offer {
  id: string;
  provider: string;
  title: string;
  totalPrice: number;
  currency: string;
  url?: string;
  conditions: OfferConditions;
  metadata?: Record<string, unknown>;
}

export interface RankedOffer extends Offer {
  score: number;
  reasons: string[];
}

export interface RankWeights {
  price: number;
  direct: number;
  baggage: number;
  refundable: number;
  convenience: number;
  /** Optional: prefer shorter itineraries when duration is known. */
  duration?: number;
}

export interface RankResult {
  ranked: RankedOffer[];
  best: RankedOffer | null;
  reasons: string[];
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  price: 0.58,
  direct: 0.16,
  baggage: 0.1,
  refundable: 0.1,
  convenience: 0.06,
  duration: 0,
};
