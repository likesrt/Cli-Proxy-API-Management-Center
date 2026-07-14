import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api/authFiles';
import type { AuthFileItem } from '@/types/authFile';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip
} from 'chart.js';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useConfigStore, useThemeStore } from '@/stores';
import {
  ModelStatsCard,
  PriceSettingsCard,
  RequestEventsDetailsCard,
  useUsageData,
  type SparklineBundle,
  type UsagePayload
} from '@/components/usage';
import type { ModelStat } from '@/components/usage/ModelStatsCard';
import { MonitorStatCards } from '@/components/monitor/MonitorStatCards';
import { MonitorTrendChart } from '@/components/monitor/MonitorTrendChart';
import { ModelUsageDistributionCard } from '@/components/monitor/ModelUsageDistributionCard';
import { MonitorApiKeyStatsCard } from '@/components/monitor/MonitorApiKeyStatsCard';
import {
  buildDailyCostSeries,
  buildDailySeriesByModel,
  buildHourlyCostSeries,
  buildHourlySeriesByModel,
  collectUsageDetails,
  filterUsageByTimeRange,
  getModelNamesFromUsage,
  getModelStats,
  type ModelPrice,
  type UsageDetail,
  type UsageTimeRange
} from '@/utils/usage';
import {
  DEFAULT_USAGE_TIME_RANGE,
  HOUR_WINDOW_BY_USAGE_TIME_RANGE,
  USAGE_TIME_RANGE_OPTIONS,
  isUsageTimeRange
} from '@/utils/usageTimeRange';
import styles from './MonitoringCenterPage.module.scss';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineController,
  LineElement,
  BarController,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const TIME_RANGE_STORAGE_KEY = 'cli-proxy-monitor-time-range-v1';

const loadTimeRange = (): UsageTimeRange => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_USAGE_TIME_RANGE;
    }
    const raw = localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    return isUsageTimeRange(raw) ? raw : DEFAULT_USAGE_TIME_RANGE;
  } catch {
    return DEFAULT_USAGE_TIME_RANGE;
  }
};

const EMPTY_SPARKLINES: {
  requests: SparklineBundle | null;
  tokens: SparklineBundle | null;
  rpm: SparklineBundle | null;
  tpm: SparklineBundle | null;
  cost: SparklineBundle | null;
} = {
  requests: null,
  tokens: null,
  rpm: null,
  tpm: null,
  cost: null
};

const sumSeries = (dataByModel: Map<string, number[]>, length: number): number[] => {
  const totals = new Array(length).fill(0);
  dataByModel.forEach((values) => {
    values.forEach((value, index) => {
      totals[index] = (totals[index] || 0) + value;
    });
  });
  return totals;
};

const trimDailySeriesToRecentDays = (
  series: { labels: string[]; data: number[] },
  days: number
): { labels: string[]; data: number[] } => {
  if (!Number.isFinite(days) || days <= 0 || series.labels.length <= days) {
    return series;
  }
  const startIndex = Math.max(series.labels.length - days, 0);
  return {
    labels: series.labels.slice(startIndex),
    data: series.data.slice(startIndex)
  };
};

const buildSparklineBundle = (
  series: { labels: string[]; data: number[] },
  color: string,
  backgroundColor: string
): SparklineBundle | null => {
  if (!series.data.length || !series.labels.length) {
    return null;
  }
  return {
    data: {
      labels: series.labels,
      datasets: [
        {
          data: series.data,
          borderColor: color,
          backgroundColor,
          fill: true,
          tension: 0.45,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    }
  };
};

const buildSparklineSeries = (usage: UsagePayload, timeRange: UsageTimeRange) => {
  if (timeRange === '7h' || timeRange === '24h') {
    const hourWindow = timeRange === '7h' ? 7 : 24;
    const requestBase = buildHourlySeriesByModel(usage, 'requests', hourWindow);
    const tokenBase = buildHourlySeriesByModel(usage, 'tokens', hourWindow);
    return {
      labels: requestBase.labels,
      requests: sumSeries(requestBase.dataByModel, requestBase.labels.length),
      tokens: sumSeries(tokenBase.dataByModel, tokenBase.labels.length)
    };
  }

  const requestBase = buildDailySeriesByModel(usage, 'requests');
  const tokenBase = buildDailySeriesByModel(usage, 'tokens');
  const requestSeries = {
    labels: requestBase.labels,
    data: sumSeries(requestBase.dataByModel, requestBase.labels.length)
  };
  const tokenSeries = {
    labels: tokenBase.labels,
    data: sumSeries(tokenBase.dataByModel, tokenBase.labels.length)
  };

  if (timeRange === '7d' || timeRange === '30d') {
    const days = timeRange === '7d' ? 7 : 30;
    const trimmedRequests = trimDailySeriesToRecentDays(requestSeries, days);
    const trimmedTokens = trimDailySeriesToRecentDays(tokenSeries, days);
    return {
      labels: trimmedRequests.labels,
      requests: trimmedRequests.data,
      tokens: trimmedTokens.data
    };
  }

  return {
    labels: requestSeries.labels,
    requests: requestSeries.data,
    tokens: tokenSeries.data
  };
};

const buildCostSeries = (
  usage: UsagePayload,
  timeRange: UsageTimeRange,
  modelPrices: Record<string, ModelPrice>
) => {
  if (!Object.keys(modelPrices).length) {
    return { labels: [], data: [] };
  }

  if (timeRange === '7h' || timeRange === '24h') {
    const hourWindow = timeRange === '7h' ? 7 : 24;
    const costBase = buildHourlyCostSeries(usage, modelPrices, hourWindow);
    return { labels: costBase.labels, data: costBase.data };
  }

  const costBase = buildDailyCostSeries(usage, modelPrices);
  const series = { labels: costBase.labels, data: costBase.data };
  if (timeRange === '7d' || timeRange === '30d') {
    return trimDailySeriesToRecentDays(series, timeRange === '7d' ? 7 : 30);
  }
  return series;
};

export function MonitoringCenterPage() {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isDark = resolvedTheme === 'dark';
  const config = useConfigStore((state) => state.config);
  const [timeRange, setTimeRange] = useState<UsageTimeRange>(loadTimeRange);
  const [usageStatsDimension, setUsageStatsDimension] = useState<'model' | 'apiKey'>('model');

  const {
    usage,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    setModelPrices,
    loadUsage,
  } = useUsageData({ timeRange });
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);

  const loadAuthFiles = useCallback(async () => {
    const res = await authFilesApi.list();
    const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
    if (!Array.isArray(files)) return;
    setAuthFiles(files);
  }, []);

  const handleRefresh = useCallback(async () => {
    await Promise.all([loadUsage(), loadAuthFiles()]);
  }, [loadAuthFiles, loadUsage]);

  useHeaderRefresh(handleRefresh);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAuthFiles().catch(() => {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAuthFiles]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, timeRange);
    } catch {
      // Ignore storage errors.
    }
  }, [timeRange]);

  // 轻量异步预计算：避免切回时在 render 同步扫 usage。
  // 明细表已分页到每页 50 行，不再需要分阶段 mount / 多段 setTimeout。
  const [ready, setReady] = useState(false);
  const [filteredUsage, setFilteredUsage] = useState<UsagePayload | null>(null);
  const [precomputedDetails, setPrecomputedDetails] = useState<UsageDetail[]>([]);
  const [precomputedModelStats, setPrecomputedModelStats] = useState<ModelStat[]>([]);
  const [sparklines, setSparklines] = useState<{
    requests: SparklineBundle | null;
    tokens: SparklineBundle | null;
    rpm: SparklineBundle | null;
    tpm: SparklineBundle | null;
    cost: SparklineBundle | null;
  }>(EMPTY_SPARKLINES);
  const [modelNames, setModelNames] = useState<string[]>([]);
  const computeIdRef = useRef(0);

  useEffect(() => {
    const computeId = ++computeIdRef.current;

    const rafId = requestAnimationFrame(() => {
      if (computeId !== computeIdRef.current) return;

      const nextFiltered = usage
        ? (filterUsageByTimeRange(usage, timeRange) as UsagePayload)
        : null;
      if (computeId !== computeIdRef.current) return;

      const details = collectUsageDetails(nextFiltered);
      if (computeId !== computeIdRef.current) return;

      const stats = getModelStats(nextFiltered, modelPrices);
      if (computeId !== computeIdRef.current) return;

      const names = getModelNamesFromUsage(usage);
      if (computeId !== computeIdRef.current) return;

      let nextSparklines = EMPTY_SPARKLINES;
      if (nextFiltered) {
        const series = buildSparklineSeries(nextFiltered, timeRange);
        const costSeries = buildCostSeries(nextFiltered, timeRange, modelPrices);
        nextSparklines = {
          requests: buildSparklineBundle(
            { labels: series.labels, data: series.requests },
            '#8b8680',
            'rgba(139, 134, 128, 0.18)'
          ),
          tokens: buildSparklineBundle(
            { labels: series.labels, data: series.tokens },
            '#8b5cf6',
            'rgba(139, 92, 246, 0.18)'
          ),
          rpm: buildSparklineBundle(
            { labels: series.labels, data: series.requests },
            '#22c55e',
            'rgba(34, 197, 94, 0.18)'
          ),
          tpm: buildSparklineBundle(
            { labels: series.labels, data: series.tokens },
            '#f97316',
            'rgba(249, 115, 22, 0.18)'
          ),
          cost: buildSparklineBundle(
            { labels: costSeries.labels, data: costSeries.data },
            '#f59e0b',
            'rgba(245, 158, 11, 0.18)'
          )
        };
      }

      if (computeId !== computeIdRef.current) return;
      setFilteredUsage(nextFiltered);
      setPrecomputedDetails(details);
      setPrecomputedModelStats(stats);
      setModelNames(names);
      setSparklines(nextSparklines);
      setReady(true);
    });

    return () => cancelAnimationFrame(rafId);
  }, [usage, timeRange, modelPrices]);

  const showOverlay = (loading && !usage) || !ready;

  const hourWindowHours =
    timeRange === 'all' ? undefined : HOUR_WINDOW_BY_USAGE_TIME_RANGE[timeRange];
  const rateWindowMinutes = useMemo(() => {
    if (timeRange === '7h') return 7 * 60;
    if (timeRange === '24h') return 24 * 60;
    if (timeRange === '7d') return 7 * 24 * 60;
    if (timeRange === '30d') return 30 * 24 * 60;
    return 30;
  }, [timeRange]);

  const handleTimeRangeChange = useCallback((range: UsageTimeRange) => {
    setTimeRange(range);
  }, []);

  const usageStatsToggle = (
    <div className={styles.periodButtons}>
      <Button
        variant={usageStatsDimension === 'model' ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => setUsageStatsDimension('model')}
      >
        {t('monitoring_center.usage_stats_by_model')}
      </Button>
      <Button
        variant={usageStatsDimension === 'apiKey' ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => setUsageStatsDimension('apiKey')}
      >
        {t('monitoring_center.usage_stats_by_api_key')}
      </Button>
    </div>
  );

  return (
    <div className={styles.container}>
      {showOverlay && (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} className={styles.loadingOverlaySpinner} />
            <span className={styles.loadingOverlayText}>{t('common.loading')}</span>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h1 className={styles.pageTitle}>{t('monitoring_center.title')}</h1>
        <div className={styles.headerActions}>
          <div className={styles.timeRangeButtons}>
            {USAGE_TIME_RANGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={timeRange === option.value ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => handleTimeRangeChange(option.value)}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRefresh().catch(() => {})}
            disabled={loading}
          >
            {loading ? t('common.loading') : t('usage_stats.refresh')}
          </Button>
          {lastRefreshedAt && (
            <span className={styles.lastRefreshed}>
              {t('usage_stats.last_updated')}: {lastRefreshedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {!showOverlay && (
        <>
          <MonitorStatCards
            usage={filteredUsage as UsagePayload | null}
            loading={loading}
            modelPrices={modelPrices}
            rateWindowMinutes={rateWindowMinutes}
            timeRange={timeRange}
            sparklines={sparklines}
          />

          <div className={styles.topGrid}>
            <MonitorTrendChart
              usage={filteredUsage as UsagePayload | null}
              loading={loading}
              isDark={isDark}
              isMobile={isMobile}
              hourWindowHours={hourWindowHours}
              modelPrices={modelPrices}
            />
            <ModelUsageDistributionCard
              modelStats={precomputedModelStats}
              loading={loading}
              isDark={isDark}
            />
          </div>

          <div className={styles.middleGrid}>
            {usageStatsDimension === 'model' ? (
              <ModelStatsCard
                modelStats={precomputedModelStats}
                loading={loading}
                hasPrices={true}
                title={t('monitoring_center.usage_stats_title')}
                extra={usageStatsToggle}
              />
            ) : (
              <MonitorApiKeyStatsCard
                usage={filteredUsage as UsagePayload | null}
                loading={loading}
                modelPrices={modelPrices}
                title={t('monitoring_center.usage_stats_title')}
                extra={usageStatsToggle}
              />
            )}
            <PriceSettingsCard
              modelNames={modelNames}
              modelPrices={modelPrices}
              onPricesChange={setModelPrices}
            />
          </div>

          <div className={styles.fullWidthSection}>
            <RequestEventsDetailsCard
              usage={filteredUsage}
              loading={loading}
              precomputedDetails={precomputedDetails}
              geminiKeys={config?.geminiApiKeys || []}
              claudeConfigs={config?.claudeApiKeys || []}
              codexConfigs={config?.codexApiKeys || []}
              vertexConfigs={config?.vertexApiKeys || []}
              openaiProviders={config?.openaiCompatibility || []}
              authFiles={authFiles}
              fixedHeight
              onRefresh={handleRefresh}
              lastRefreshedAt={lastRefreshedAt}
            />
          </div>
        </>
      )}
    </div>
  );
}
