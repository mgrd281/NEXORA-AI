const home = {
  title: 'Home',
  greeting: {
    morning: 'Good morning, {name}',
    afternoon: 'Good afternoon, {name}',
    evening: 'Good evening, {name}',
  },
  greetingAnonymous: {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
  },
  status: {
    ready: 'Ready',
    offlinePlanner: 'Ready in basic mode',
    approvals: '{count, plural, one {Needs your approval} other {# requests need your approval}}',
    working: '{count, plural, one {Working on # task} other {Working on # tasks}}',
    queued: '{count, plural, one {# task waiting to start} other {# tasks waiting to start}}',
  },
  sections: {
    approvals: 'Needs you',
    active: 'In progress',
    recent: 'Recent results',
  },
  sectionCount: '{count, plural, one {# item} other {# items}}',
  viewAll: 'View all',
  approval: {
    review: 'Review',
    reviewLabel: 'Review: {title}',
    expires: 'Expires {time}',
  },
  loading: 'Loading your overview…',
  loadError: 'Couldn’t load your overview.',
  firstRun: {
    title: 'Ask for something in your own words',
    body: 'JARVIS plans the steps, checks them against your safety settings and shows you anything that acts on your behalf before it happens.',
    stepPlan: 'You see the plan before anything runs',
    stepApprove: 'Emails and other actions wait for your approval',
    stepEvidence: 'Every result comes with its evidence',
    tryLabel: 'Try one of these',
  },
  examples: {
    summarize: 'Summarize https://www.w3.org/TR/WCAG22/',
    remember: 'Remember that I prefer aisle seats on flights',
    emailMe: 'Email me: call the dentist on Friday',
  },
  suggestionsLabel: 'Suggestions',
  suggestionFills: 'Puts this request into the command bar',
  suggest: {
    enableWeb: 'Allow JARVIS to read public web pages',
    connectEmail: 'Connect your email so JARVIS can send messages',
    configureModel: 'JARVIS is running without an AI model — see what it can do',
    summarizeAndEmail: 'Summarize a web page and email it to yourself',
    remember: 'Tell JARVIS something to remember',
  },
  suggestCommands: {
    summarizeAndEmail: 'Summarize https:// and email it to me',
    remember: 'Remember that ',
  },
};

export default home;
