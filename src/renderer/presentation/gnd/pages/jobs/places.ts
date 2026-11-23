// Places offered as you type a location: UK cities and towns first, then
// cities with lots of design and tech roles, then countries. Bundled so
// suggestions work offline. Pure: no I/O.

type Place = { name: string; country: string };

const UK = 'United Kingdom';
const uk = (names: string) =>
  names.split('|').map((name): Place => ({ name, country: UK }));
const at = (country: string, names: string) =>
  names.split('|').map((name): Place => ({ name, country }));

const CITIES: Place[] = [
  ...uk(
    'London|Manchester|Birmingham|Leeds|Glasgow|Edinburgh|Liverpool|Bristol|Sheffield|Newcastle upon Tyne|Nottingham|Leicester|Cardiff|Belfast|Brighton|Cambridge|Oxford|Reading|Milton Keynes|Southampton|Portsmouth|Bath|York|Coventry|Aberdeen|Dundee|Swansea|Exeter|Norwich|Plymouth|Derby|Stoke-on-Trent|Hull|Bournemouth|Guildford|Watford|Slough|St Albans|Luton|Chelmsford|Canterbury|Ipswich|Peterborough|Northampton|Wolverhampton|Sunderland|Middlesbrough|Preston|Lancaster|Chester|Durham|Warrington|Stockport|Salford|Bradford|Huddersfield|Harrogate|Lincoln|Gloucester|Cheltenham|Worcester|Swindon|Basingstoke|Crawley|Maidstone|Colchester|Inverness|Stirling|Perth|Newport|Wrexham|Derry|Croydon|Kingston upon Thames|Richmond|Barnet|Wimbledon|Stratford|Canary Wharf|Woking|Farnborough|High Wycombe|Bracknell|Maidenhead|Hemel Hempstead|Stevenage|Harlow|Southend-on-Sea|Leamington Spa|Solihull|Telford|Shrewsbury|Carlisle|Blackpool|Bolton|Wigan|Doncaster|Rotherham|Wakefield|Hastings|Eastbourne|Winchester|Salisbury|Truro|Falmouth',
  ),
  ...at('Ireland', 'Dublin|Cork|Galway|Limerick'),
  ...at('France', 'Paris|Lyon|Marseille|Toulouse|Bordeaux|Lille|Nantes'),
  ...at(
    'Germany',
    'Berlin|Munich|Hamburg|Frankfurt|Cologne|Stuttgart|Düsseldorf',
  ),
  ...at('Netherlands', 'Amsterdam|Rotterdam|The Hague|Utrecht|Eindhoven'),
  ...at('Belgium', 'Brussels|Antwerp|Ghent'),
  ...at('Luxembourg', 'Luxembourg'),
  ...at('Switzerland', 'Zurich|Geneva|Basel|Lausanne'),
  ...at('Austria', 'Vienna'),
  ...at('Czechia', 'Prague'),
  ...at('Poland', 'Warsaw|Kraków|Wrocław'),
  ...at('Hungary', 'Budapest'),
  ...at('Portugal', 'Lisbon|Porto'),
  ...at('Spain', 'Madrid|Barcelona|Valencia|Málaga|Seville'),
  ...at('Italy', 'Milan|Rome|Turin|Bologna'),
  ...at('Denmark', 'Copenhagen|Aarhus'),
  ...at('Sweden', 'Stockholm|Gothenburg|Malmö'),
  ...at('Norway', 'Oslo'),
  ...at('Finland', 'Helsinki'),
  ...at('Estonia', 'Tallinn'),
  ...at('Latvia', 'Riga'),
  ...at('Lithuania', 'Vilnius'),
  ...at('Greece', 'Athens'),
  ...at('Romania', 'Bucharest'),
  ...at('Bulgaria', 'Sofia'),
  ...at('Croatia', 'Zagreb'),
  ...at('Iceland', 'Reykjavik'),
  ...at('Türkiye', 'Istanbul'),
  ...at(
    'United States',
    'New York|San Francisco|Los Angeles|Seattle|Austin|Boston|Chicago|Washington DC|Denver|Atlanta|Miami|San Diego|San Jose|Portland|Dallas|Houston|Philadelphia',
  ),
  ...at('Canada', 'Toronto|Vancouver|Montreal'),
  ...at('Mexico', 'Mexico City'),
  ...at('Brazil', 'São Paulo'),
  ...at('Argentina', 'Buenos Aires'),
  ...at('United Arab Emirates', 'Dubai|Abu Dhabi'),
  ...at('Israel', 'Tel Aviv'),
  ...at('Saudi Arabia', 'Riyadh'),
  ...at('Qatar', 'Doha'),
  ...at('Egypt', 'Cairo'),
  ...at('Nigeria', 'Lagos'),
  ...at('Kenya', 'Nairobi'),
  ...at('South Africa', 'Cape Town|Johannesburg'),
  ...at('India', 'Bengaluru|Mumbai|Delhi|Hyderabad|Pune|Chennai'),
  ...at('Singapore', 'Singapore'),
  ...at('Hong Kong', 'Hong Kong'),
  ...at('China', 'Shanghai|Beijing|Shenzhen'),
  ...at('Taiwan', 'Taipei'),
  ...at('Japan', 'Tokyo|Osaka'),
  ...at('South Korea', 'Seoul'),
  ...at('Malaysia', 'Kuala Lumpur'),
  ...at('Thailand', 'Bangkok'),
  ...at('Indonesia', 'Jakarta'),
  ...at('Philippines', 'Manila'),
  ...at('Vietnam', 'Ho Chi Minh City'),
  ...at('Australia', 'Sydney|Melbourne|Brisbane|Perth|Adelaide'),
  ...at('New Zealand', 'Auckland|Wellington'),
];

const COUNTRIES = [
  UK,
  'England',
  'Scotland',
  'Wales',
  'Northern Ireland',
  'Ireland',
  'Europe',
  'United States',
  'Canada',
  'Germany',
  'France',
  'Netherlands',
  'Spain',
  'Portugal',
  'Australia',
];

export type PlaceOption = {
  /** What goes on the pill and into the search. */
  value: string;
  /** Shown under it in the list, e.g. "United Kingdom". */
  detail: string;
};

const repeated = new Set(
  CITIES.map((c) => c.name).filter((name, i, all) => all.indexOf(name) !== i),
);

/** Every place once; a name used twice (Perth) keeps its country on it. */
export const PLACES: readonly PlaceOption[] = [
  ...CITIES.map((c) => ({
    value:
      repeated.has(c.name) && c.country !== UK
        ? `${c.name}, ${c.country}`
        : c.name,
    detail: c.country,
  })),
  ...COUNTRIES.map((value) => ({ value, detail: 'Country or region' })),
];

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .trim();

/**
 * Up to `limit` places for what's typed: names that start with it first, then
 * names with a word that starts with it. Already-picked places are left out.
 */
export function suggestPlaces(
  typed: string,
  chosen: readonly string[],
  limit = 6,
): PlaceOption[] {
  const query = fold(typed);
  if (!query) return [];
  const picked = new Set(chosen.map(fold));
  const open = PLACES.filter((p) => !picked.has(fold(p.value)));
  const starts = open.filter((p) => fold(p.value).startsWith(query));
  const words = open.filter(
    (p) =>
      !starts.includes(p) &&
      fold(p.value)
        .split(/[\s,-]+/u)
        .some((word) => word.startsWith(query)),
  );
  return [...starts, ...words].slice(0, limit);
}

/** The listed spelling of a place, if we know it ("london" -> "London"). */
export function knownPlace(typed: string): string | null {
  const query = fold(typed);
  return PLACES.find((p) => fold(p.value) === query)?.value ?? null;
}

/** The country a listed city is in, for matching "United Kingdom" to "Leeds". */
export function countryOf(place: string): string | null {
  const query = fold(place);
  return CITIES.find((c) => fold(c.name) === query)?.country ?? null;
}

export function citiesIn(country: string): string[] {
  const query = fold(country);
  const isUk = [
    'united kingdom',
    'uk',
    'england',
    'scotland',
    'wales',
    'northern ireland',
  ].includes(query);
  return CITIES.filter((c) =>
    isUk ? c.country === UK : fold(c.country) === query,
  ).map((c) => c.name);
}

/**
 * Where to start someone's search: London, plus the city they're in when we
 * can tell, from their profile location ("Leeds, UK") or their time zone.
 */
export function defaultPlaces(
  profileLocation: string | null | undefined,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string[] {
  const fromProfile = knownPlace((profileLocation ?? '').split(',')[0] ?? '');
  const fromZone = knownPlace(
    (timeZone ?? '').split('/').pop()?.replace(/_/gu, ' ') ?? '',
  );
  const out = ['London'];
  const local = fromProfile ?? fromZone;
  if (local && fold(local) !== 'london') out.push(local);
  return out;
}
