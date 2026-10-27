import { useEffect, useState } from "react";
import type { BlockDef, Vocabulary } from "../../../shared/types";
import { api, type ShowIfField } from "../api/client";

// Catalogs change rarely (custom blocks when Settings change), so they are cached per session.
type BlockCatalog = { blocks: BlockDef[]; fields: ShowIfField[]; placeholders: string[] };
let blocksP: Promise<BlockCatalog> | null = null;
let vocabP: Promise<Vocabulary> | null = null;

export const loadBlocks = () => (blocksP ??= api.blocks().catch((e) => ((blocksP = null), Promise.reject(e))));
export const loadVocabulary = () => (vocabP ??= api.vocabulary().catch((e) => ((vocabP = null), Promise.reject(e))));
export const invalidateBlocks = () => {
  blocksP = null;
};

export function useBlocks() {
  const [data, setData] = useState<BlockCatalog | null>(null);
  useEffect(() => {
    loadBlocks().then(setData, () => undefined);
  }, []);
  return data;
}

export function useVocabulary() {
  const [data, setData] = useState<Vocabulary | null>(null);
  useEffect(() => {
    loadVocabulary().then(setData, () => undefined);
  }, []);
  return data;
}

/** Plain-language label for an audience key, e.g. a segment, from the vocabulary. */
export function vocabLabel(v: Vocabulary | null, kind: keyof Omit<Vocabulary, "offers">, key: string) {
  return v?.[kind].find((x) => x.key === key)?.description ?? key.replace(/_/g, " ");
}
