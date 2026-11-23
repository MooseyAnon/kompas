// Skills offered as you type, Otta-style. Bundled so it works offline; people
// can still add a skill that isn't listed. Pure: no I/O.

const GROUPS: Record<string, string> = {
  design:
    'Product design|UX design|UI design|Interaction design|Visual design|Service design|Design systems|Design thinking|Design leadership|Design strategy|Design ops|Prototyping|Wireframing|User flows|Information architecture|Accessibility|Inclusive design|Responsive design|Mobile design|Motion design|Illustration|Branding|Typography|Content design|UX writing|Usability testing|User research|Qualitative research|Quantitative research|Customer journey mapping|Personas|Workshop facilitation|Figma|FigJam|Sketch|Adobe XD|Adobe Photoshop|Adobe Illustrator|Adobe After Effects|Framer|Principle|Protopie|Miro|Maze|Dovetail|Webflow|Storybook|Zeroheight|Graphic design|Game design|3D design|Blender',
  product:
    'Product management|Product strategy|Product discovery|Roadmapping|Prioritisation|OKRs|A/B testing|Experimentation|Product analytics|Growth|Go-to-market|Pricing|Market research|Competitive analysis|User stories|Requirements gathering|Agile|Scrum|Kanban|Lean|Jira|Confluence|Linear|Notion|Amplitude|Mixpanel|Google Analytics|Hotjar|FullStory|Stakeholder management|Cross-functional collaboration',
  engineering:
    'JavaScript|TypeScript|React|Next.js|Vue|Angular|Svelte|HTML|CSS|Sass|Tailwind CSS|Node.js|Python|Django|Flask|FastAPI|Java|Kotlin|Swift|SwiftUI|Objective-C|Go|Rust|C|C++|C#|.NET|Ruby|Ruby on Rails|PHP|Laravel|Scala|Elixir|SQL|PostgreSQL|MySQL|SQLite|MongoDB|Redis|GraphQL|REST APIs|gRPC|Microservices|System design|AWS|Google Cloud|Azure|Docker|Kubernetes|Terraform|CI/CD|GitHub Actions|Git|Linux|Bash|Testing|Test automation|Cypress|Playwright|Jest|Security|DevOps|Site reliability|Observability|Electron|React Native|Flutter|iOS development|Android development|Front-end development|Back-end development|Full-stack development|Embedded systems|Mobile development|Web performance',
  data: 'Data analysis|Data science|Data engineering|Data visualisation|Machine learning|Deep learning|Natural language processing|Computer vision|Statistics|Excel|Google Sheets|Tableau|Power BI|Looker|dbt|Snowflake|BigQuery|Spark|Airflow|Pandas|NumPy|R|PyTorch|TensorFlow|LLMs|Prompt engineering|MLOps|Business intelligence|Forecasting',
  business:
    'Payments|Fintech|Banking|Open banking|Compliance|Risk management|KYC|Fraud prevention|Lending|Insurance|Crypto|E-commerce|Marketplaces|SaaS|B2B|B2C|Healthcare|Edtech|Retail|Logistics|Operations|Project management|Programme management|Strategy|Consulting|Business analysis|Financial modelling|Accounting|Sales|Account management|Customer success|Customer support|Partnerships|Business development|Procurement|Recruiting|People management|HR|Legal',
  marketing:
    'Marketing|Digital marketing|Content marketing|Content strategy|Copywriting|SEO|SEM|Paid social|Email marketing|Social media|Community management|Brand strategy|Public relations|Product marketing|Performance marketing|Marketing analytics|CRM|HubSpot|Salesforce|Video editing|Photography',
  people:
    'Leadership|Mentoring|Coaching|Hiring|Team building|Communication|Presentation skills|Public speaking|Storytelling|Negotiation|Problem solving|Critical thinking|Decision making|Facilitation|Time management|Remote collaboration|Teaching|Writing|Research|Languages|Mandarin|Spanish|French|German',
};

export const SKILLS: readonly string[] = [
  ...new Set(Object.values(GROUPS).flatMap((group) => group.split('|'))),
];

const fold = (text: string) => text.toLowerCase().replace(/\s+/gu, ' ').trim();

/**
 * Up to `limit` skills for what's typed: those starting with it first, then
 * those with a word starting with it. Skills already added are left out.
 */
export function suggestSkills(
  typed: string,
  chosen: readonly string[],
  limit = 7,
): string[] {
  const query = fold(typed);
  if (!query) return [];
  const have = new Set(chosen.map(fold));
  const open = SKILLS.filter((skill) => !have.has(fold(skill)));
  const starts = open.filter((skill) => fold(skill).startsWith(query));
  const words = open.filter(
    (skill) =>
      !starts.includes(skill) &&
      fold(skill)
        .split(/[\s/.-]+/u)
        .some((word) => word.startsWith(query)),
  );
  return [...starts, ...words].slice(0, limit);
}

/** The listed spelling of a skill ("figma" -> "Figma"), if we have it. */
export function knownSkill(typed: string): string | null {
  const query = fold(typed);
  return SKILLS.find((skill) => fold(skill) === query) ?? null;
}
