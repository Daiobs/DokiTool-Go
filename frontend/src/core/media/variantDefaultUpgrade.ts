import type { Variant } from "../../types/media";
import { resolveVariantResolution } from "./variantSort";

/**
 * Pure default-variant selection & automatic quality upgrade rules shared
 * across Web SPA, Extension SidePanel, and Extension Quick Download.
 *
 * Extracted cohesively from `variantSort.ts` to keep every `src/core/**`
 * module well below the 600-line complexity cap.
 */

/**
 * Resolves the effective default variant option for an item given already
 * canonically sorted options and an optional explicit user manual choice.
 *
 * - If the user manually selected a variant ID present in `sortedOptions`, keeps it.
 * - Otherwise selects the top-ranked downloadable video option (or top downloadable
 *   option if audio-only), enabling automatic upgrade (e.g. Web 720p -> 1080p H.264
 *   when the extension connects, and XHS 4K original endpoint by default).
 */
export function resolveEffectiveDefaultVariant<
  T extends {
    variant: { id: string };
    downloadable: boolean;
    isAudioOnly?: boolean;
  },
>(
  sortedOptions: ReadonlyArray<T>,
  userManualVariantId?: string | null,
): T | null {
  if (!sortedOptions.length) return null;
  if (userManualVariantId) {
    const manual = sortedOptions.find(
      (opt) => opt.variant.id === userManualVariantId,
    );
    if (manual) return manual;
  }
  const topDownloadableVideo = sortedOptions.find(
    (opt) => opt.downloadable && !opt.isAudioOnly,
  );
  if (topDownloadableVideo) return topDownloadableVideo;
  const topDownloadable = sortedOptions.find((opt) => opt.downloadable);
  return topDownloadable ?? sortedOptions[0] ?? null;
}

/**
 * Determines whether the Web UI should automatically upgrade the active variant
 * from the server's `item.default` to `bestOption` when the user has not made
 * an explicit manual selection.
 *
 * Preserves three Unified-v1 / playback invariants:
 * - Never auto-selects when `item.default` is absent (`defaultOption == null`),
 *   keeping the explicit "请先选择画质" prompt for processing-required items.
 * - Never silently replaces an unprobed (`resolutionTier === 0`) server default
 *   with a backup unless `bestOption` is an unlocked `extensionMux` or
 *   `provenance === "original_endpoint"`.
 * - Never degrades an inline-audible server default into a silent-preview split
 *   track (`has_audio === false`) unless `extensionMux` (with playable fallback)
 *   is handling playback & muxing.
 */
export function shouldAutoUpgradeDefaultVariant(
  defaultOption: {
    variant: Variant;
    downloadable?: boolean;
    extensionMux?: boolean;
    clientSplitMux?: boolean;
  } | null,
  bestOption: {
    variant: Variant;
    downloadable: boolean;
    extensionMux?: boolean;
    clientSplitMux?: boolean;
  } | null,
): boolean {
  if (!defaultOption || !bestOption || !bestOption.downloadable) return false;
  if (bestOption.variant.id === defaultOption.variant.id) return false;

  if (bestOption.extensionMux && !defaultOption.extensionMux) {
    return true;
  }
  if (bestOption.clientSplitMux && !defaultOption.clientSplitMux) {
    const defaultRes = resolveVariantResolution(defaultOption.variant);
    const bestRes = resolveVariantResolution(bestOption.variant);
    if (
      defaultRes.resolutionTier <= 0 ||
      bestRes.resolutionTier > defaultRes.resolutionTier ||
      (bestRes.resolutionTier === defaultRes.resolutionTier &&
        bestRes.fps > defaultRes.fps)
    ) {
      return true;
    }
  }
  if (
    bestOption.variant.provenance === "original_endpoint" &&
    defaultOption.variant.provenance !== "original_endpoint"
  ) {
    return true;
  }

  const bestMeta =
    bestOption.variant.state !== "deferred"
      ? bestOption.variant.metadata
      : undefined;
  const defaultMeta =
    defaultOption.variant.state !== "deferred"
      ? defaultOption.variant.metadata
      : undefined;

  if (bestMeta?.has_audio === false && defaultMeta?.has_audio !== false) {
    return false;
  }

  const defaultRes = resolveVariantResolution(defaultOption.variant);
  const bestRes = resolveVariantResolution(bestOption.variant);
  if (defaultRes.resolutionTier <= 0) {
    return false;
  }
  return (
    bestRes.resolutionTier > defaultRes.resolutionTier ||
    (bestRes.resolutionTier === defaultRes.resolutionTier &&
      bestRes.fps > defaultRes.fps)
  );
}
