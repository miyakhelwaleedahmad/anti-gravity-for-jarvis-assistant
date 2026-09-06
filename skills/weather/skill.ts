/**
 * skills/weather/skill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Weather skill using Open-Meteo (free, no API key required).
 * Falls back to a web search description if geocoding fails.
 */

interface WeatherArgs {
  location: string;
  units?: 'metric' | 'imperial';
}

interface GeoResult {
  latitude: number;
  longitude: number;
  name: string;
  country: string;
}

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

async function geocode(location: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json() as any;
  const r = data?.results?.[0];
  if (!r) return null;
  return { latitude: r.latitude, longitude: r.longitude, name: r.name, country: r.country };
}

export async function execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const location = String(args['location'] ?? '').trim();
  const units = (args['units'] as string) === 'imperial' ? 'fahrenheit' : 'celsius';
  const tempUnit = units === 'fahrenheit' ? '°F' : '°C';
  const windUnit = units === 'fahrenheit' ? 'mph' : 'km/h';
  const windParam = units === 'fahrenheit' ? 'mph' : 'kmh';

  if (!location) return 'Error: location is required for weather lookup.';

  let geo: GeoResult | null;
  try {
    geo = await geocode(location);
  } catch {
    return `Error: Could not reach geocoding service for "${location}".`;
  }

  if (!geo) {
    return `Error: Could not find location "${location}". Please check the spelling.`;
  }

  const weatherUrl = [
    `https://api.open-meteo.com/v1/forecast`,
    `?latitude=${geo.latitude}&longitude=${geo.longitude}`,
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature`,
    `&daily=temperature_2m_max,temperature_2m_min,weather_code`,
    `&temperature_unit=${units}`,
    `&wind_speed_unit=${windParam}`,
    `&forecast_days=3`,
    `&timezone=auto`,
  ].join('');

  let weatherData: any;
  try {
    const res = await fetch(weatherUrl, { signal: signal ?? AbortSignal.timeout(8000) });
    if (!res.ok) return `Error: Weather API returned ${res.status}`;
    weatherData = await res.json();
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    return `Error: Could not fetch weather data — ${String(err)}`;
  }

  const cur = weatherData?.current;
  const daily = weatherData?.daily;
  if (!cur) return `Error: No weather data returned for ${geo.name}.`;

  const condition = WMO_CODES[cur.weather_code as number] ?? 'Unknown';
  const lines: string[] = [
    `🌍 Weather for ${geo.name}, ${geo.country}:`,
    `  Condition:    ${condition}`,
    `  Temperature:  ${cur.temperature_2m}${tempUnit} (feels like ${cur.apparent_temperature}${tempUnit})`,
    `  Humidity:     ${cur.relative_humidity_2m}%`,
    `  Wind:         ${cur.wind_speed_10m} ${windUnit}`,
  ];

  if (daily?.temperature_2m_max && daily?.temperature_2m_min) {
    lines.push('', '📅 3-Day Forecast:');
    const dates: string[] = daily.time ?? [];
    for (let i = 0; i < Math.min(3, dates.length); i++) {
      const dayCondition = WMO_CODES[daily.weather_code[i] as number] ?? '';
      lines.push(`  ${dates[i]}: ${daily.temperature_2m_min[i]}${tempUnit} – ${daily.temperature_2m_max[i]}${tempUnit}  ${dayCondition}`);
    }
  }

  return lines.join('\n');
}

export default { execute };
