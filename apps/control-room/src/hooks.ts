import { useCallback, useEffect, useRef, useState } from "react";

import type { Page } from "@blogmaatic/operator-client";

interface CollectionState<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: Error | null;
  readonly reload: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
}

export function usePagedCollection<T>(
  key: string,
  loader: (cursor?: string) => Promise<Page<T>>,
): CollectionState<T> {
  const [items, setItems] = useState<readonly T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setLoadingMore(false);
    setNextCursor(undefined);
    setError(null);
    try {
      const page = await loader();
      if (request !== sequence.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (request !== sequence.current) return;
      setError(cause instanceof Error ? cause : new Error("Collection request failed"));
      setItems([]);
      setNextCursor(undefined);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [key, loader]);

  useEffect(() => {
    void reload();
    return () => { sequence.current += 1; };
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (loading || !nextCursor || loadingMore) return;
    const request = ++sequence.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await loader(nextCursor);
      if (request !== sequence.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (request !== sequence.current) return;
      setError(cause instanceof Error ? cause : new Error("Collection request failed"));
    } finally {
      if (request === sequence.current) setLoadingMore(false);
    }
  }, [loader, loading, loadingMore, nextCursor]);

  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
    loading,
    loadingMore,
    error,
    reload,
    loadMore,
  };
}
