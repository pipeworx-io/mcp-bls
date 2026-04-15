interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * BLS MCP — Bureau of Labor Statistics public data API (v2)
 *
 * No auth needed for basic access. Optional _apiKey (BLS registration key) for higher rate limits.
 * API: https://api.bls.gov/publicAPI/v2/timeseries/data/
 *
 * Tools:
 * - bls_get_series: get time series data for one or more BLS series
 * - bls_search: look up common series IDs by keyword (curated reference)
 * - bls_latest: get the most recent data point for a series
 * - bls_popular_series: list popular housing & employment series with descriptions
 */


const API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';

// ── Curated series catalog ──────────────────────────────────────────────

interface SeriesEntry {
  id: string;
  title: string;
  category: string;
  description: string;
}

const CURATED_SERIES: SeriesEntry[] = [
  // Employment
  { id: 'CES0000000001', title: 'Total Nonfarm Employment', category: 'employment', description: 'Total nonfarm payroll employment (seasonally adjusted), the headline jobs number from the monthly Employment Situation report.' },
  { id: 'LNS14000000', title: 'Unemployment Rate', category: 'employment', description: 'Civilian unemployment rate (seasonally adjusted), percentage of labor force that is unemployed.' },
  { id: 'LNS11300000', title: 'Labor Force Participation Rate', category: 'employment', description: 'Civilian labor force participation rate (seasonally adjusted).' },
  { id: 'CES2000000001', title: 'Construction Employment', category: 'employment', description: 'Total construction sector employment (seasonally adjusted). Key indicator for housing construction activity.' },
  { id: 'CES2023610001', title: 'Residential Building Construction Employment', category: 'housing', description: 'Employment in residential building construction (NAICS 2361).' },
  { id: 'CES2023800001', title: 'Specialty Trade Contractors Employment', category: 'housing', description: 'Employment in specialty trade contractors (NAICS 238), includes plumbing, electrical, HVAC for housing.' },
  { id: 'JTS000000000000000HIR', title: 'JOLTS Total Hires', category: 'employment', description: 'Total hires from the Job Openings and Labor Turnover Survey (JOLTS).' },
  { id: 'JTS000000000000000JOL', title: 'JOLTS Job Openings', category: 'employment', description: 'Total job openings from JOLTS.' },
  { id: 'JTS000000000000000QUR', title: 'JOLTS Quits Rate', category: 'employment', description: 'Total quits rate from JOLTS, a measure of worker confidence.' },
  { id: 'CES0500000003', title: 'Average Hourly Earnings (Private)', category: 'wages', description: 'Average hourly earnings of all employees on private nonfarm payrolls (seasonally adjusted).' },

  // Prices / CPI
  { id: 'CUUR0000SA0', title: 'CPI-U All Items', category: 'prices', description: 'Consumer Price Index for All Urban Consumers, all items (not seasonally adjusted). The headline inflation measure.' },
  { id: 'CUUR0000SA0L1E', title: 'CPI-U All Items Less Food & Energy', category: 'prices', description: 'Core CPI excluding food and energy (not seasonally adjusted).' },
  { id: 'CUUR0000SEHA', title: 'CPI-U Rent of Primary Residence', category: 'housing', description: 'CPI for rent of primary residence (not seasonally adjusted). Key housing cost component.' },
  { id: 'CUUR0000SEHC', title: 'CPI-U Owners Equivalent Rent', category: 'housing', description: 'CPI for owners\' equivalent rent of residences (not seasonally adjusted). Largest single component of CPI.' },
  { id: 'CUUR0000SAH1', title: 'CPI-U Shelter', category: 'housing', description: 'CPI for shelter (not seasonally adjusted). Covers rent, owners\' equivalent rent, lodging.' },
  { id: 'CUUR0000SEHF01', title: 'CPI-U Electricity', category: 'housing', description: 'CPI for electricity (not seasonally adjusted). Housing utility cost.' },
  { id: 'CUUR0000SEHF02', title: 'CPI-U Piped Gas', category: 'housing', description: 'CPI for utility (piped) gas service (not seasonally adjusted).' },

  // Producer Prices
  { id: 'PCU236211236211', title: 'PPI Residential Construction', category: 'housing', description: 'Producer Price Index for new single-family residential construction (general contractors).' },
  { id: 'WPU081', title: 'PPI Lumber & Wood Products', category: 'housing', description: 'Producer Price Index for lumber and wood products. Key input cost for housing construction.' },

  // Productivity
  { id: 'PRS85006092', title: 'Nonfarm Business Labor Productivity', category: 'productivity', description: 'Output per hour of all persons in the nonfarm business sector (seasonally adjusted).' },
  { id: 'PRS85006112', title: 'Nonfarm Business Unit Labor Costs', category: 'productivity', description: 'Unit labor costs in the nonfarm business sector (seasonally adjusted).' },
];

function extractKey(args: Record<string, unknown>): string | undefined {
  const key = args._apiKey as string | undefined;
  delete args._apiKey;
  return key || undefined;
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'bls_get_series',
    description:
      'Get time series data from the Bureau of Labor Statistics for one or more series. Supports employment, CPI/inflation, wages, productivity, and housing-related series.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'BLS series ID (e.g., "LNS14000000" for unemployment rate). For multiple series, comma-separate them (e.g., "LNS14000000,CES0000000001").' },
        start_year: { type: 'string', description: 'Start year (e.g., "2023"). Default: current year minus 2.' },
        end_year: { type: 'string', description: 'End year (e.g., "2024"). Default: current year.' },
        _apiKey: { type: 'string', description: 'BLS registration key (optional, increases rate limits)' },
      },
      required: ['series_id'],
    },
  },
  {
    name: 'bls_search',
    description:
      'Search for BLS series IDs by keyword from a curated catalog of popular housing, employment, wages, prices, and productivity series. Returns matching series IDs with descriptions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Keyword to search for (e.g., "rent", "construction", "unemployment", "CPI", "housing")' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'bls_latest',
    description:
      'Get just the most recent data point for a BLS series. Useful for quick current-value lookups.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'BLS series ID (e.g., "LNS14000000")' },
        _apiKey: { type: 'string', description: 'BLS registration key (optional)' },
      },
      required: ['series_id'],
    },
  },
  {
    name: 'bls_popular_series',
    description:
      'List all curated popular BLS series with IDs and descriptions, organized by category (housing, employment, prices, wages, productivity). Use this to discover available series.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category: housing, employment, prices, wages, productivity (optional, returns all if omitted)' },
      },
    },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'bls_get_series':
      return getSeriesData(args);
    case 'bls_search':
      return searchSeries(args.keyword as string);
    case 'bls_latest':
      return getLatest(args);
    case 'bls_popular_series':
      return listPopularSeries(args.category as string | undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool implementations ────────────────────────────────────────────────

type BlsSeriesData = {
  seriesID: string;
  data: {
    year: string;
    period: string;
    periodName: string;
    value: string;
    latest?: string;
    footnotes?: { code: string; text: string }[];
  }[];
};

type BlsApiResponse = {
  status: string;
  responseTime: number;
  message: string[];
  Results: {
    series: BlsSeriesData[];
  };
};

async function blsFetch(
  seriesIds: string[],
  opts: { startYear?: string; endYear?: string; latest?: boolean; registrationkey?: string },
): Promise<BlsApiResponse> {
  const currentYear = new Date().getFullYear();
  const body: Record<string, unknown> = {
    seriesid: seriesIds,
    startyear: opts.startYear ?? String(currentYear - 2),
    endyear: opts.endYear ?? String(currentYear),
  };
  if (opts.latest) body.latest = true;
  if (opts.registrationkey) body.registrationkey = opts.registrationkey;

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BLS API error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as BlsApiResponse;

  if (data.status === 'REQUEST_NOT_PROCESSED') {
    throw new Error(`BLS API request not processed: ${data.message?.join('; ') ?? 'Unknown error'}`);
  }

  return data;
}

async function getSeriesData(args: Record<string, unknown>) {
  const key = extractKey(args);
  const rawIds = args.series_id as string;
  const seriesIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean);

  if (seriesIds.length === 0) throw new Error('At least one series_id is required');
  if (seriesIds.length > 50) throw new Error('Maximum 50 series per request');

  const data = await blsFetch(seriesIds, {
    startYear: args.start_year as string | undefined,
    endYear: args.end_year as string | undefined,
    registrationkey: key,
  });

  return {
    status: data.status,
    series: data.Results.series.map((s) => ({
      series_id: s.seriesID,
      data: s.data.map((d) => ({
        year: d.year,
        period: d.period,
        period_name: d.periodName,
        value: d.value,
        latest: d.latest === 'true',
      })),
    })),
  };
}

function searchSeries(keyword: string) {
  const lower = keyword.toLowerCase();
  const matches = CURATED_SERIES.filter(
    (s) =>
      s.title.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower) ||
      s.category.toLowerCase().includes(lower) ||
      s.id.toLowerCase().includes(lower),
  );

  return {
    keyword,
    total_matches: matches.length,
    series: matches.map((s) => ({
      series_id: s.id,
      title: s.title,
      category: s.category,
      description: s.description,
    })),
    note: matches.length === 0
      ? 'No matches in curated catalog. Try broader keywords or use bls_popular_series to browse all available series. You can also use any valid BLS series ID directly with bls_get_series.'
      : undefined,
  };
}

async function getLatest(args: Record<string, unknown>) {
  const key = extractKey(args);
  const seriesId = args.series_id as string;

  const data = await blsFetch([seriesId], {
    latest: true,
    registrationkey: key,
  });

  const series = data.Results.series[0];
  if (!series || series.data.length === 0) {
    throw new Error(`No data returned for series: ${seriesId}`);
  }

  const latest = series.data[0];
  const catalogEntry = CURATED_SERIES.find((s) => s.id === seriesId);

  return {
    series_id: series.seriesID,
    title: catalogEntry?.title ?? null,
    latest: {
      year: latest.year,
      period: latest.period,
      period_name: latest.periodName,
      value: latest.value,
    },
  };
}

function listPopularSeries(category?: string) {
  const filtered = category
    ? CURATED_SERIES.filter((s) => s.category.toLowerCase() === category.toLowerCase())
    : CURATED_SERIES;

  const grouped: Record<string, { series_id: string; title: string; description: string }[]> = {};
  for (const s of filtered) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push({
      series_id: s.id,
      title: s.title,
      description: s.description,
    });
  }

  return {
    filter_category: category ?? null,
    total_series: filtered.length,
    categories: grouped,
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
