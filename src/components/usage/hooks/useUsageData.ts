import { useEffect, useState, useCallback } from 'react';
import { USAGE_STATS_STALE_TIME_MS, useUsageStatsStore } from '@/stores/useUsageStatsStore';
import { loadModelPrices, saveModelPrices, type ModelPrice, type UsageTimeRange } from '@/utils/usage';

export interface UsagePayload {
  total_requests?: number;
  success_count?: number;
  failure_count?: number;
  total_tokens?: number;
  apis?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UseUsageDataOptions {
  timeRange?: UsageTimeRange;
  minimumLookbackMs?: number;
  refreshFullRange?: boolean;
}

export interface UseUsageDataReturn {
  usage: UsagePayload | null;
  loading: boolean;
  error: string;
  lastRefreshedAt: Date | null;
  modelPrices: Record<string, ModelPrice>;
  setModelPrices: (prices: Record<string, ModelPrice>) => void;
  loadUsage: () => Promise<void>;
}

export function useUsageData(options: UseUsageDataOptions = {}): UseUsageDataReturn {
  const { timeRange, minimumLookbackMs, refreshFullRange = false } = options;
  const usageSnapshot = useUsageStatsStore((state) => state.usage);
  const loading = useUsageStatsStore((state) => state.loading);
  const storeError = useUsageStatsStore((state) => state.error);
  const lastRefreshedAtTs = useUsageStatsStore((state) => state.lastRefreshedAt);
  const loadUsageStats = useUsageStatsStore((state) => state.loadUsageStats);

  const [modelPrices, setModelPrices] = useState<Record<string, ModelPrice>>(() => loadModelPrices());

  const loadUsage = useCallback(async () => {
    await loadUsageStats({
      force: true,
      fullRange: refreshFullRange,
      staleTimeMs: USAGE_STATS_STALE_TIME_MS,
      timeRange,
      minimumLookbackMs,
    });
  }, [loadUsageStats, minimumLookbackMs, refreshFullRange, timeRange]);

  // 页面 mount / 切换回来：优先吃缓存，不要 force 全量重拉。
  // 手动刷新走 loadUsage(force:true)。
  useEffect(() => {
    void loadUsageStats({
      force: false,
      fullRange: false,
      staleTimeMs: USAGE_STATS_STALE_TIME_MS,
      timeRange,
      minimumLookbackMs,
    }).catch(() => {});
  }, [loadUsageStats, minimumLookbackMs, timeRange]);

  const handleSetModelPrices = useCallback((prices: Record<string, ModelPrice>) => {
    setModelPrices(prices);
    saveModelPrices(prices);
  }, []);

  const usage = usageSnapshot as UsagePayload | null;
  const error = storeError || '';
  const lastRefreshedAt = lastRefreshedAtTs ? new Date(lastRefreshedAtTs) : null;

  return {
    usage,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    setModelPrices: handleSetModelPrices,
    loadUsage,
  };
}
