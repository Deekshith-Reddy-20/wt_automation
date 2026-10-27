/**
 * Suraj Solar — Multilingual WhatsApp Lead Qualification.
 *
 * Single source of truth for every customer-facing string in the flow
 * (Telugu, English, Hindi) and the builder that turns them into Flows
 * engine nodes. The seed script (scripts/seed-suraj-solar.mjs) imports
 * this file directly with Node's TypeScript type stripping, so it must
 * stay self-contained: no imports and only erasable TypeScript syntax.
 *
 * Journey: first inbound message → welcome + language buttons →
 * category list → category questions (each skippable, typed answers
 * accepted) → callback consent → lead scoring → CRM update → closing
 * message → handoff to the sales queue (round robin).
 *
 * Wording rules: short, everyday Andhra Telugu / simple Hindi / Indian
 * English; one question per message; never promise subsidy, savings,
 * eligibility, financing or installation dates. Option `crm` labels are
 * what the CRM stores — keep them stable when rewording a title.
 */

export type Lang = "te" | "en" | "hi";
/** Display order of the language menu: Telugu, English, Hindi. */
export const LANGS: readonly Lang[] = ["te", "en", "hi"];
export type L10n = Record<Lang, string>;

export const LEAD_FLOW_NAME = "Suraj Solar — Multilingual WhatsApp Lead Qualification";
export const LEAD_FLOW_DESCRIPTION =
  "Greets new WhatsApp conversations, asks for a language (Telugu / English / Hindi), qualifies the solar requirement with category-specific questions, scores the lead (HOT / WARM / NURTURE), saves answers to the contact and hands off to the sales team.";

/** Typed messages that restart the flow from the welcome step. */
export const RESTART_KEYWORDS = ["menu", "main menu", "restart", "start over", "మెనూ", "मेनू"];

export const WELCOME_TEXT =
  "Hi! 👋 Welcome to Suraj Solar.\n\nWe can help you choose the right solar solution for your home, business or farm.\n\nPlease select your preferred language to continue.";

/**
 * Language buttons in menu order. Routing uses only the stable reply id,
 * never the button position or its title.
 */
export const LANGUAGE_OPTIONS: ReadonlyArray<{ id: string; lang: Lang; title: string; crm: string }> = [
  { id: "lang_te", lang: "te", title: "తెలుగు", crm: "Telugu" },
  { id: "lang_en", lang: "en", title: "English", crm: "English" },
  { id: "lang_hi", lang: "hi", title: "हिंदी", crm: "Hindi" },
];

export const languageReplyId = (lang: Lang): string => LANGUAGE_OPTIONS.find((l) => l.lang === lang)!.id;

const MENU_HINT: L10n = {
  en: "Type \"menu\" anytime to start again.",
  te: "మళ్ళీ మొదటి నుంచి మొదలుపెట్టాలంటే ఎప్పుడైనా \"మెనూ\" అని పంపండి.",
  hi: "फिर से शुरू करने के लिए कभी भी \"मेनू\" लिखकर भेजें।",
};

export const MESSAGES = {
  categoryPrompt: {
    en: "Great, let's get started! ☀️\n\nWhat kind of solar solution are you looking for? Please choose one option.",
    te: "సరే, మొదలుపెడదాం! ☀️\n\nమీకు ఎలాంటి సోలార్ కావాలి? కింద ఉన్న ఆప్షన్లలో ఒకటి ఎంచుకోండి.",
    hi: "ठीक है, चलिए शुरू करते हैं! ☀️\n\nआपको किस तरह का सोलर चाहिए? नीचे से एक ऑप्शन चुनें।",
  },
  categoryButton: { en: "See options", te: "ఆప్షన్లు చూడండి", hi: "ऑप्शन देखें" },
  categorySection: { en: "Solar options", te: "సోలార్ ఆప్షన్లు", hi: "सोलर ऑप्शन" },
  chooseButton: { en: "Choose", te: "ఎంచుకోండి", hi: "चुनें" },
  answerFooter: {
    en: "Or just type your answer",
    te: "లేదా మీ జవాబు టైప్ చేయండి",
    hi: "या अपना जवाब टाइप करें",
  },
  skip: { en: "Skip", te: "స్కిప్ చేయండి", hi: "छोड़ें" },
  notSure: { en: "Not sure", te: "సరిగ్గా తెలియదు", hi: "पक्का नहीं पता" },
  other: { en: "Other", te: "వేరేది", hi: "कुछ और" },
  confirmation: {
    en: "Thank you! We have noted your solar enquiry. ☀️\n\nWould you like our team to call you?",
    te: "ధన్యవాదాలు! మీ సోలార్ వివరాలు నోట్ చేసుకున్నాం. ☀️\n\nమా టీమ్ మీకు కాల్ చేయాలా?",
    hi: "धन्यवाद! आपकी सोलर जानकारी हमने नोट कर ली है। ☀️\n\nक्या हमारी टीम आपको कॉल करे?",
  },
  callbackTimePrompt: {
    en: "What time is best for us to call you?",
    te: "మేము ఏ టైమ్‌లో కాల్ చేస్తే మీకు బాగుంటుంది?",
    hi: "आपको किस समय कॉल करना ठीक रहेगा?",
  },
  callbackTimeButton: { en: "Choose time", te: "టైమ్ ఎంచుకోండి", hi: "समय चुनें" },
  finalCallback: {
    en: `Thank you! We have noted your callback request. Someone from the Suraj Solar team will call you to understand your requirement.\n\n${MENU_HINT.en}`,
    te: `ధన్యవాదాలు! మీ కాల్‌బ్యాక్ రిక్వెస్ట్ నోట్ చేసుకున్నాం. మీ అవసరం గురించి మాట్లాడటానికి సూరజ్ సోలార్ టీమ్ నుంచి మీకు కాల్ వస్తుంది.\n\n${MENU_HINT.te}`,
    hi: `धन्यवाद! आपकी कॉलबैक रिक्वेस्ट हमने नोट कर ली है। आपकी ज़रूरत समझने के लिए सूरज सोलर की टीम आपको कॉल करेगी।\n\n${MENU_HINT.hi}`,
  },
  finalNotNow: {
    en: `No problem! Your details are saved. You can message us here anytime when you are ready.\n\n${MENU_HINT.en}`,
    te: `పర్లేదు! మీ వివరాలు సేవ్ అయ్యాయి. మీకు వీలైనప్పుడు ఇక్కడే మాకు మెసేజ్ చేయండి.\n\n${MENU_HINT.te}`,
    hi: `कोई बात नहीं! आपकी जानकारी सेव हो गई है। जब भी आप तैयार हों, यहाँ हमें मैसेज करें।\n\n${MENU_HINT.hi}`,
  },
} satisfies Record<string, L10n>;

export interface QuestionOption {
  id: string;
  title: L10n;
  description?: L10n;
  /** English label written to the CRM ("" = record nothing). */
  crm: string;
}

export interface Question {
  /** Stable var key the answer is stored under in flow_runs.vars. */
  key: string;
  /** buttons (≤3 options), list (≤10 rows) or text (typed, with a Skip button). */
  kind: "buttons" | "list" | "text";
  text: L10n;
  options: QuestionOption[];
}

export type CategoryId =
  | "solar_residential"
  | "solar_commercial"
  | "solar_society"
  | "solar_pump"
  | "solar_battery";

export const CATEGORIES: ReadonlyArray<{
  id: CategoryId;
  short: string;
  title: L10n;
  description: L10n;
  crm: string;
}> = [
  {
    id: "solar_residential",
    short: "res",
    title: { en: "Home rooftop solar", te: "ఇంటి రూఫ్ సోలార్", hi: "घर की छत पर सोलर" },
    description: {
      en: "For your house, villa or flat",
      te: "ఇల్లు, విల్లా లేదా ఫ్లాట్ కోసం",
      hi: "घर, विला या फ्लैट के लिए",
    },
    crm: "Residential rooftop",
  },
  {
    id: "solar_commercial",
    short: "com",
    title: { en: "Business / Industry", te: "బిజినెస్ / ఫ్యాక్టరీ", hi: "बिज़नेस / फैक्ट्री" },
    description: {
      en: "Shops, offices, factories, hotels, hospitals",
      te: "షాపులు, ఆఫీసులు, ఫ్యాక్టరీలు, హోటళ్లు, హాస్పిటల్స్",
      hi: "दुकान, ऑफिस, फैक्ट्री, होटल, अस्पताल",
    },
    crm: "Commercial",
  },
  {
    id: "solar_society",
    short: "soc",
    title: { en: "Apartment / Society", te: "అపార్ట్‌మెంట్ / సొసైటీ", hi: "अपार्टमेंट / सोसाइटी" },
    description: {
      en: "Common areas of apartments and gated communities",
      te: "అపార్ట్‌మెంట్లు, గేటెడ్ కమ్యూనిటీల కామన్ ఏరియా కోసం",
      hi: "अपार्टमेंट और सोसाइटी के कॉमन एरिया के लिए",
    },
    crm: "Housing society",
  },
  {
    id: "solar_pump",
    short: "pump",
    title: { en: "Solar pump / Farm", te: "సోలార్ పంప్ / పొలం", hi: "सोलर पंप / खेती" },
    description: {
      en: "For farm irrigation and drinking water",
      te: "పొలానికి నీళ్లు, తాగునీటి కోసం",
      hi: "खेत की सिंचाई और पीने के पानी के लिए",
    },
    crm: "Solar water pump",
  },
  {
    id: "solar_battery",
    short: "bat",
    title: { en: "Battery / Backup", te: "బ్యాటరీ / బ్యాకప్", hi: "बैटरी / बैकअप" },
    description: {
      en: "Backup during power cuts, with or without solar",
      te: "కరెంట్ పోయినప్పుడు బ్యాకప్ కోసం, సోలార్‌తో లేదా లేకుండా",
      hi: "बिजली जाने पर बैकअप के लिए, सोलर के साथ या बिना",
    },
    crm: "Battery / backup",
  },
];

/** Extra category-menu row that skips qualification and goes to a person. */
export const TALK_TO_SALES = {
  id: "solar_talk_sales",
  title: { en: "Talk to our team", te: "మా టీమ్‌తో మాట్లాడండి", hi: "हमारी टीम से बात करें" },
  description: {
    en: "Chat with someone from Suraj Solar",
    te: "సూరజ్ సోలార్ టీమ్‌తో నేరుగా చాట్ చేయండి",
    hi: "सूरज सोलर की टीम से सीधे बात करें",
  },
  reply: {
    en: `Sure! We have passed your request to the Suraj Solar team. Someone from our team will reply to you here.\n\n${MENU_HINT.en}`,
    te: `తప్పకుండా! మీ రిక్వెస్ట్ సూరజ్ సోలార్ టీమ్‌కి పంపాం. మా టీమ్ నుంచి ఒకరు ఇక్కడే మీకు రిప్లై ఇస్తారు.\n\n${MENU_HINT.te}`,
    hi: `ज़रूर! आपकी रिक्वेस्ट सूरज सोलर की टीम को भेज दी गई है। हमारी टीम से कोई आपको यहीं जवाब देगा।\n\n${MENU_HINT.hi}`,
  },
  crm: "Talk to sales team",
} as const;

// ------------------------------------------------------------
// Question catalogue
// ------------------------------------------------------------

const opt = (id: string, en: string, te: string, hi: string, crm: string = en): QuestionOption => ({
  id,
  title: { en, te, hi },
  crm,
});
const notSure = (id: string): QuestionOption => ({ id, title: MESSAGES.notSure, crm: "Not sure" });
const other = (id: string): QuestionOption => ({ id, title: MESSAGES.other, crm: "Other" });
const skip = (id: string): QuestionOption => ({ id, title: MESSAGES.skip, crm: "" });

const CITY: Question = {
  key: "city",
  kind: "text",
  text: {
    en: "Where will the solar be installed? Please type your city, town or village name.",
    te: "సోలార్ ఎక్కడ పెట్టాలి? మీ ఊరు లేదా సిటీ పేరు టైప్ చేయండి.",
    hi: "सोलर कहाँ लगवाना है? अपने शहर, कस्बे या गाँव का नाम लिखें।",
  },
  options: [skip("city_skip")],
};

const TIMELINE: Question = {
  key: "timeline",
  kind: "list",
  text: {
    en: "When are you planning to get solar installed?",
    te: "సోలార్ ఎప్పుడు పెట్టించుకోవాలనుకుంటున్నారు?",
    hi: "आप सोलर कब तक लगवाना चाहते हैं?",
  },
  options: [
    opt("timeline_1m", "Within 1 month", "1 నెలలోపు", "1 महीने के अंदर"),
    opt("timeline_3m", "In 1–3 months", "1–3 నెలల్లో", "1–3 महीने में", "1–3 months"),
    opt("timeline_6m", "In 3–6 months", "3–6 నెలల్లో", "3–6 महीने में", "3–6 months"),
    opt("timeline_exploring", "Just checking for now", "ఇప్పుడు తెలుసుకోడానికే", "अभी बस जानकारी चाहिए", "Just exploring"),
    notSure("timeline_unsure"),
  ],
};

/** Asked only when the contact has no name on file. */
export const NAME_QUESTION: Question = {
  key: "customer_name",
  kind: "text",
  text: {
    en: "May I know your name? Please type it below.",
    te: "మీ పేరు చెప్తారా? కింద టైప్ చేయండి.",
    hi: "आपका नाम क्या है? नीचे टाइप करें।",
  },
  options: [skip("name_skip")],
};

const billOptions = (prefix: string, bands: Array<[string, string, string, string]>) => [
  ...bands.map(([suffix, en, te, hi]) => opt(`${prefix}_${suffix}`, en, te, hi)),
  notSure(`${prefix}_unsure`),
];

export const CATEGORY_QUESTIONS: Record<CategoryId, Question[]> = {
  solar_residential: [
    {
      key: "res_property",
      kind: "list",
      text: {
        en: "What type of home is it?",
        te: "మీది ఎలాంటి ఇల్లు?",
        hi: "आपका घर किस तरह का है?",
      },
      options: [
        opt("res_prop_house", "Independent house", "ఇండిపెండెంట్ ఇల్లు", "इंडिपेंडेंट मकान"),
        opt("res_prop_apartment", "Apartment / flat", "అపార్ట్‌మెంట్ / ఫ్లాట్", "अपार्टमेंट / फ्लैट"),
        opt("res_prop_villa", "Villa", "విల్లా", "विला"),
        other("res_prop_other"),
        notSure("res_prop_unsure"),
      ],
    },
    {
      key: "res_bill",
      kind: "list",
      text: {
        en: "Roughly how much is your monthly electricity bill?",
        te: "మీ ఇంటికి నెలకు కరెంట్ బిల్లు ఎంత వస్తుంది?",
        hi: "आपके घर का बिजली का बिल हर महीने लगभग कितना आता है?",
      },
      options: billOptions("res_bill", [
        ["lt_1500", "Below ₹1,500", "₹1,500 కంటే తక్కువ", "₹1,500 से कम"],
        ["1500_2500", "₹1,500–₹2,500", "₹1,500–₹2,500", "₹1,500–₹2,500"],
        ["2500_4000", "₹2,500–₹4,000", "₹2,500–₹4,000", "₹2,500–₹4,000"],
        ["4000_8000", "₹4,000–₹8,000", "₹4,000–₹8,000", "₹4,000–₹8,000"],
        ["8000_15000", "₹8,000–₹15,000", "₹8,000–₹15,000", "₹8,000–₹15,000"],
        ["gt_15000", "Above ₹15,000", "₹15,000 కంటే ఎక్కువ", "₹15,000 से ज़्यादा"],
      ]),
    },
    CITY,
    {
      key: "res_roof",
      kind: "list",
      text: { en: "What type of roof does your house have?", te: "మీ ఇంటి రూఫ్ ఎలాంటిది?", hi: "आपके घर की छत कैसी है?" },
      options: [
        opt("res_roof_rcc", "Concrete (RCC) roof", "కాంక్రీట్ (RCC) స్లాబ్", "कंक्रीट (RCC) छत"),
        opt("res_roof_sheet", "Metal / tin sheet", "రేకుల రూఫ్", "टीन / मेटल शीट"),
        opt("res_roof_tile", "Tiled roof", "పెంకుల రూఫ్", "खपरैल / टाइल की छत"),
        opt("res_roof_shared", "Shared terrace", "కామన్ టెర్రస్", "कॉमन छत"),
        notSure("res_roof_unsure"),
      ],
    },
    TIMELINE,
  ],
  solar_commercial: [
    {
      key: "com_business",
      kind: "list",
      text: {
        en: "What type of business do you have?",
        te: "మీది ఏ రకమైన బిజినెస్?",
        hi: "आपका बिज़नेस किस तरह का है?",
      },
      options: [
        opt("com_biz_shop", "Shop / showroom", "షాప్ / షోరూమ్", "दुकान / शोरूम"),
        opt("com_biz_office", "Office", "ఆఫీస్", "ऑफिस"),
        opt("com_biz_factory", "Factory / industry", "ఫ్యాక్టరీ / ఇండస్ట్రీ", "फैक्ट्री / इंडस्ट्री"),
        opt("com_biz_hotel", "Hotel / restaurant", "హోటల్ / రెస్టారెంట్", "होटल / रेस्टोरेंट"),
        opt("com_biz_institution", "Hospital / school", "హాస్పిటల్ / స్కూల్", "अस्पताल / स्कूल"),
        opt("com_biz_warehouse", "Warehouse / cold storage", "గోడౌన్ / కోల్డ్ స్టోరేజ్", "गोदाम / कोल्ड स्टोरेज"),
        other("com_biz_other"),
      ],
    },
    {
      key: "com_bill",
      kind: "list",
      text: {
        en: "Roughly how much is the monthly electricity bill for your business?",
        te: "మీ బిజినెస్‌కి నెలకు కరెంట్ బిల్లు ఎంత వస్తుంది?",
        hi: "आपके बिज़नेस का बिजली का बिल हर महीने लगभग कितना आता है?",
      },
      options: billOptions("com_bill", [
        ["lt_10000", "Below ₹10,000", "₹10,000 కంటే తక్కువ", "₹10,000 से कम"],
        ["10000_25000", "₹10,000–₹25,000", "₹10,000–₹25,000", "₹10,000–₹25,000"],
        ["25000_50000", "₹25,000–₹50,000", "₹25,000–₹50,000", "₹25,000–₹50,000"],
        ["50000_100000", "₹50,000–₹1,00,000", "₹50,000–₹1,00,000", "₹50,000–₹1,00,000"],
        ["100000_500000", "₹1,00,000–₹5,00,000", "₹1,00,000–₹5,00,000", "₹1,00,000–₹5,00,000"],
        ["gt_500000", "Above ₹5,00,000", "₹5,00,000 కంటే ఎక్కువ", "₹5,00,000 से ज़्यादा"],
      ]),
    },
    CITY,
    {
      key: "com_site",
      kind: "list",
      text: {
        en: "Where can the solar panels be put up?",
        te: "సోలార్ ప్యానెల్స్ ఎక్కడ పెట్టొచ్చు?",
        hi: "सोलर पैनल कहाँ लगाए जा सकते हैं?",
      },
      options: [
        opt("com_site_rcc", "Concrete roof", "కాంక్రీట్ స్లాబ్ రూఫ్", "कंक्रीट की छत", "Concrete rooftop"),
        opt("com_site_sheet", "Metal sheet roof", "రేకుల రూఫ్", "मेटल शीट की छत"),
        opt("com_site_land", "Open land", "ఖాళీ స్థలం", "खुली ज़मीन"),
        opt("com_site_both", "Both roof and land", "రూఫ్, స్థలం రెండూ", "छत और ज़मीन दोनों", "Rooftop and land"),
        notSure("com_site_unsure"),
      ],
    },
    TIMELINE,
  ],
  solar_society: [
    {
      key: "soc_name",
      kind: "text",
      text: {
        en: "What is the name of your apartment or society? Please type it.",
        te: "మీ అపార్ట్‌మెంట్ లేదా సొసైటీ పేరు ఏంటి? టైప్ చేయండి.",
        hi: "आपकी सोसाइटी या अपार्टमेंट का नाम क्या है? टाइप करें।",
      },
      options: [skip("soc_name_skip")],
    },
    {
      key: "soc_homes",
      kind: "list",
      text: {
        en: "How many flats or homes are there in your society?",
        te: "మీ సొసైటీలో ఎన్ని ఫ్లాట్లు / ఇళ్లు ఉన్నాయి?",
        hi: "आपकी सोसाइटी में कितने फ्लैट या घर हैं?",
      },
      options: [
        opt("soc_homes_lt_25", "Below 25", "25 కంటే తక్కువ", "25 से कम"),
        opt("soc_homes_25_50", "25–50", "25–50", "25–50"),
        opt("soc_homes_50_100", "50–100", "50–100", "50–100"),
        opt("soc_homes_100_250", "100–250", "100–250", "100–250"),
        opt("soc_homes_gt_250", "Above 250", "250 కంటే ఎక్కువ", "250 से ज़्यादा"),
        notSure("soc_homes_unsure"),
      ],
    },
    {
      key: "soc_needs",
      kind: "list",
      text: {
        en: "What should solar run in the common areas?",
        te: "కామన్ ఏరియాలో సోలార్‌తో ఏవి నడవాలి?",
        hi: "कॉमन एरिया में सोलर से क्या चलाना है?",
      },
      options: [
        opt("soc_needs_lighting", "Common area lights", "కామన్ ఏరియా లైట్లు", "कॉमन एरिया की लाइटें", "Common lighting"),
        opt("soc_needs_lifts", "Lifts and water pumps", "లిఫ్ట్‌లు, వాటర్ పంపులు", "लिफ्ट और पानी के पंप"),
        opt("soc_needs_all", "All common area use", "కామన్ ఏరియా మొత్తం", "पूरा कॉमन एरिया", "All common loads"),
        opt("soc_needs_ev", "EV charging", "EV ఛార్జింగ్", "EV चार्जिंग"),
        notSure("soc_needs_unsure"),
      ],
    },
    CITY,
    {
      key: "soc_rooftop",
      kind: "buttons",
      text: {
        en: "Is there space on the terrace for solar panels?",
        te: "సోలార్ ప్యానెల్స్ పెట్టడానికి టెర్రస్ మీద స్థలం ఉందా?",
        hi: "क्या छत पर सोलर पैनल लगाने की जगह है?",
      },
      options: [
        opt("soc_roof_yes", "Yes, there is", "అవును, ఉంది", "हाँ, जगह है", "Yes, available"),
        opt("soc_roof_partly", "Some space", "కొంచెం ఉంది", "थोड़ी जगह है", "Partly"),
        notSure("soc_roof_unsure"),
      ],
    },
    {
      key: "soc_role",
      kind: "list",
      text: {
        en: "What is your role in the society?",
        te: "సొసైటీలో మీ రోల్ ఏంటి?",
        hi: "सोसाइटी में आपका रोल क्या है?",
      },
      options: [
        opt("soc_role_committee", "Committee member", "కమిటీ మెంబర్", "कमेटी मेंबर"),
        opt("soc_role_manager", "Facility manager", "ఫెసిలిటీ మేనేజర్", "फैसिलिटी मैनेजर"),
        opt("soc_role_resident", "Resident", "రెసిడెంట్ (నివాసి)", "निवासी"),
        opt("soc_role_builder", "Builder / developer", "బిల్డర్ / డెవలపర్", "बिल्डर / डेवलपर"),
        other("soc_role_other"),
      ],
    },
    TIMELINE,
  ],
  solar_pump: [
    {
      key: "pump_use",
      kind: "list",
      text: {
        en: "What will you use the solar pump for?",
        te: "సోలార్ పంప్ దేనికోసం కావాలి?",
        hi: "सोलर पंप किस काम के लिए चाहिए?",
      },
      options: [
        opt("pump_use_irrigation", "Farming / irrigation", "పొలానికి నీళ్లు", "खेत की सिंचाई", "Irrigation / farming"),
        opt("pump_use_drinking", "Drinking water", "తాగునీరు", "पीने का पानी"),
        opt("pump_use_livestock", "Cattle / dairy", "పశువులు / డెయిరీ", "पशु / डेयरी", "Livestock / dairy"),
        other("pump_use_other"),
        notSure("pump_use_unsure"),
      ],
    },
    CITY,
    {
      key: "pump_hp",
      kind: "list",
      text: {
        en: "What size of pump do you need (in HP)?",
        te: "మీకు ఎన్ని HP పంప్ కావాలి?",
        hi: "आपको कितने HP का पंप चाहिए?",
      },
      options: [
        opt("pump_hp_3", "Up to 3 HP", "3 HP వరకు", "3 HP तक"),
        opt("pump_hp_5", "5 HP", "5 HP", "5 HP"),
        opt("pump_hp_7_5", "7.5 HP", "7.5 HP", "7.5 HP"),
        opt("pump_hp_10", "10 HP or more", "10 HP లేదా ఎక్కువ", "10 HP या ज़्यादा"),
        notSure("pump_hp_unsure"),
      ],
    },
    {
      key: "pump_connection",
      kind: "list",
      text: {
        en: "How do you run your pump right now?",
        te: "ఇప్పుడు పంప్ దేనితో నడుస్తుంది?",
        hi: "अभी आपका पंप किससे चलता है?",
      },
      options: [
        opt("pump_conn_grid", "Electricity connection", "కరెంట్ కనెక్షన్", "बिजली कनेक्शन", "Grid electricity"),
        opt("pump_conn_diesel", "Diesel pump", "డీజిల్ ఇంజిన్", "डीज़ल इंजन"),
        opt("pump_conn_none", "No pump yet", "ఇంకా పంప్ లేదు", "अभी पंप नहीं है"),
        notSure("pump_conn_unsure"),
      ],
    },
    TIMELINE,
  ],
  solar_battery: [
    {
      key: "bat_existing",
      kind: "buttons",
      text: {
        en: "Do you already have solar panels?",
        te: "మీ దగ్గర ఇప్పటికే సోలార్ ప్యానెల్స్ ఉన్నాయా?",
        hi: "क्या आपके यहाँ पहले से सोलर पैनल लगे हैं?",
      },
      options: [
        opt("bat_solar_yes", "Yes, I have solar", "అవును, ఉన్నాయి", "हाँ, लगे हैं"),
        opt("bat_solar_no", "No, not yet", "ఇంకా లేవు", "अभी नहीं", "No solar yet"),
        notSure("bat_solar_unsure"),
      ],
    },
    {
      key: "bat_backup",
      kind: "list",
      text: {
        en: "Why do you need battery backup?",
        te: "బ్యాటరీ బ్యాకప్ దేనికోసం కావాలి?",
        hi: "बैटरी बैकअप किसलिए चाहिए?",
      },
      options: [
        opt("bat_need_cuts", "Power cuts at home", "ఇంట్లో కరెంట్ కోతలు", "घर में बिजली कटौती"),
        opt("bat_need_business", "Keep business running", "బిజినెస్ ఆగకుండా", "बिज़नेस बिना रुके चले", "Business continuity"),
        opt("bat_need_offgrid", "Fully off-grid power", "పూర్తిగా ఆఫ్-గ్రిడ్", "पूरी तरह ऑफ-ग्रिड"),
        notSure("bat_need_unsure"),
      ],
    },
    {
      key: "bat_appliances",
      kind: "list",
      text: {
        en: "What should run on backup during a power cut?",
        te: "కరెంట్ పోయినప్పుడు బ్యాకప్‌తో ఏవి నడవాలి?",
        hi: "बिजली जाने पर बैकअप से क्या-क्या चलना चाहिए?",
      },
      options: [
        opt("bat_load_basic", "Lights and fans", "లైట్లు, ఫ్యాన్లు", "लाइट और पंखे"),
        opt("bat_load_medium", "Plus TV and fridge", "+ టీవీ, ఫ్రిజ్", "+ टीवी और फ्रिज"),
        opt("bat_load_heavy", "Plus AC or motor", "+ ఏసీ లేదా మోటార్", "+ एसी या मोटर"),
        opt("bat_load_full", "Full home / office", "ఇల్లు / ఆఫీస్ మొత్తం", "पूरा घर / ऑफिस", "Entire home / office"),
        notSure("bat_load_unsure"),
      ],
    },
    {
      key: "bat_property",
      kind: "list",
      text: {
        en: "Where do you need the battery backup?",
        te: "బ్యాటరీ బ్యాకప్ ఎక్కడ కావాలి?",
        hi: "बैटरी बैकअप कहाँ चाहिए?",
      },
      options: [
        opt("bat_prop_house", "House", "ఇల్లు", "घर", "House"),
        opt("bat_prop_apartment", "Apartment", "అపార్ట్‌మెంట్", "अपार्टमेंट"),
        opt("bat_prop_shop", "Shop / office", "షాప్ / ఆఫీస్", "दुकान / ऑफिस"),
        opt("bat_prop_factory", "Factory", "ఫ్యాక్టరీ", "फैक्ट्री"),
        opt("bat_prop_farm", "Farm", "పొలం", "खेत"),
        other("bat_prop_other"),
      ],
    },
    CITY,
    TIMELINE,
  ],
};

export const CALLBACK_CONSENT: Question = {
  key: "callback_consent",
  kind: "buttons",
  text: MESSAGES.confirmation,
  options: [
    opt("callback_yes", "Yes, call me", "అవును, కాల్ చేయండి", "हाँ, कॉल करें"),
    opt("callback_choose_time", "Pick a time", "టైమ్ చెప్పండి", "समय चुनें", "Callback at a chosen time"),
    opt("callback_not_now", "Not now", "ఇప్పుడు వద్దు", "अभी नहीं"),
  ],
};

export const CALLBACK_TIME: Question = {
  key: "callback_time",
  kind: "list",
  text: MESSAGES.callbackTimePrompt,
  options: [
    opt("callback_morning", "Morning (9 AM–12 PM)", "ఉదయం (9–12)", "सुबह (9–12 बजे)", "Morning (9am–12pm)"),
    opt("callback_afternoon", "Afternoon (12–4 PM)", "మధ్యాహ్నం (12–4)", "दोपहर (12–4 बजे)", "Afternoon (12pm–4pm)"),
    opt("callback_evening", "Evening (4–7 PM)", "సాయంత్రం (4–7)", "शाम (4–7 बजे)", "Evening (4pm–7pm)"),
    opt("callback_anytime", "Any time is fine", "ఎప్పుడైనా పర్లేదు", "कभी भी चलेगा", "Any time"),
  ],
};

// ------------------------------------------------------------
// Lead scoring — transparent and editable in the flow builder.
// Language choice and greetings never add points.
// ------------------------------------------------------------

export const LEAD_SCORING = {
  rules: [
    { var_key: "timeline", values: ["timeline_1m"], points: 30, label: "Install within 1 month" },
    { var_key: "timeline", values: ["timeline_3m"], points: 20, label: "Install in 1–3 months" },
    { var_key: "timeline", values: ["timeline_6m"], points: 10, label: "Install in 3–6 months" },
    { var_key: "res_bill", values: ["res_bill_4000_8000", "res_bill_8000_15000", "res_bill_gt_15000"], points: 25, label: "Home bill ₹4,000+" },
    { var_key: "res_bill", values: ["res_bill_2500_4000"], points: 15, label: "Home bill ₹2,500–₹4,000" },
    { var_key: "res_bill", values: ["res_bill_1500_2500"], points: 5, label: "Home bill ₹1,500–₹2,500" },
    { var_key: "com_bill", values: ["com_bill_50000_100000", "com_bill_100000_500000", "com_bill_gt_500000"], points: 25, label: "Business bill ₹50,000+" },
    { var_key: "com_bill", values: ["com_bill_10000_25000", "com_bill_25000_50000"], points: 15, label: "Business bill ₹10,000–₹50,000" },
    { var_key: "soc_homes", values: ["soc_homes_100_250", "soc_homes_gt_250"], points: 25, label: "Society with 100+ homes" },
    { var_key: "soc_homes", values: ["soc_homes_50_100"], points: 15, label: "Society with 50–100 homes" },
    { var_key: "soc_homes", values: ["soc_homes_25_50"], points: 5, label: "Society with 25–50 homes" },
    { var_key: "soc_role", values: ["soc_role_committee", "soc_role_builder"], points: 10, label: "Society decision-maker" },
    { var_key: "pump_hp", values: ["pump_hp_5", "pump_hp_7_5", "pump_hp_10"], points: 15, label: "Pump 5 HP+" },
    { var_key: "pump_connection", values: ["pump_conn_diesel"], points: 10, label: "Replacing a diesel pump" },
    { var_key: "bat_appliances", values: ["bat_load_heavy", "bat_load_full"], points: 15, label: "Heavy backup load" },
    { var_key: "bat_existing", values: ["bat_solar_yes"], points: 10, label: "Already has solar" },
    { var_key: "res_roof", values: ["res_roof_rcc"], points: 10, label: "Concrete roof" },
    { var_key: "com_site", values: ["com_site_rcc", "com_site_land", "com_site_both"], points: 10, label: "Suitable site" },
    { var_key: "soc_rooftop", values: ["soc_roof_yes"], points: 10, label: "Rooftop available" },
    { var_key: "callback_consent", values: ["callback_yes", "callback_choose_time"], points: 20, label: "Asked for a callback" },
  ],
  bands: [
    { label: "HOT", min_score: 60 },
    { label: "WARM", min_score: 30 },
  ],
  fallback_label: "NURTURE",
  score_var: "lead_score",
  category_var: "lead_priority",
};

// ------------------------------------------------------------
// CRM wiring
// ------------------------------------------------------------

/** Custom fields the flow writes. Existing seed fields are reused by name. */
export const LEAD_FLOW_CUSTOM_FIELDS: ReadonlyArray<[string, string[]]> = [
  ["Location", ["City / area / village"]],
  ["Property type", ["Residential", "Commercial", "Agricultural", "Industrial"]],
  ["Electricity bill amount", ["Monthly ₹ amount or range"]],
  ["Solar requirement", [...CATEGORIES.map((c) => c.crm), TALK_TO_SALES.crm]],
  ["Lead source", ["WhatsApp"]],
  ["Lead priority", ["HOT", "WARM", "NURTURE"]],
  ["Follow-up date", ["YYYY-MM-DD"]],
  ["Lead status", ["New Lead"]],
  ["Preferred language", LANGUAGE_OPTIONS.map((l) => l.crm)],
  ["Lead score", ["0–100 points"]],
  ["Installation timeline", ["Within 1 month", "1–3 months", "3–6 months", "Just exploring", "Not sure"]],
  ["Roof / site details", ["Concrete (RCC) roof", "Metal sheet roof", "Open land"]],
  ["Callback preference", ["Yes, call me", "Callback at a chosen time", "Not now"]],
  ["Preferred callback time", CALLBACK_TIME.options.map((o) => o.crm)],
  ["Qualification summary", ["Priority · score · reasons"]],
];

export const LEAD_FLOW_TAGS = { newEnquiry: "New Enquiry", hot: "Hot Lead" } as const;

function allQuestions(): Question[] {
  const seen = new Map<string, Question>();
  for (const qs of Object.values(CATEGORY_QUESTIONS)) for (const q of qs) seen.set(q.key, q);
  for (const q of [NAME_QUESTION, CALLBACK_CONSENT, CALLBACK_TIME]) seen.set(q.key, q);
  return [...seen.values()];
}

/** reply_id → English CRM label for one question (skip → ""). */
export function crmValueMap(key: string): Record<string, string> {
  if (key === "language") return Object.fromEntries(LANGUAGE_OPTIONS.map((l) => [l.id, l.crm]));
  if (key === "solar_category") {
    return Object.fromEntries([...CATEGORIES.map((c) => [c.id, c.crm]), [TALK_TO_SALES.id, TALK_TO_SALES.crm]]);
  }
  const question = allQuestions().find((q) => q.key === key);
  if (!question) throw new Error(`Unknown question ${key}`);
  return Object.fromEntries(question.options.map((o) => [o.id, o.crm]));
}

const LEAD_NOTE = [
  "WhatsApp lead qualification (Suraj Solar flow)",
  "Language: {{vars.language_label}}",
  "Requirement: {{vars.solar_category_label}}",
  "Property: {{vars.res_property_label}}",
  "Business type: {{vars.com_business_label}}",
  "Society: {{vars.soc_name_label}}",
  "Homes in society: {{vars.soc_homes_label}}",
  "Common-area needs: {{vars.soc_needs_label}}",
  "Role: {{vars.soc_role_label}}",
  "Pump use: {{vars.pump_use_label}}",
  "Pump capacity: {{vars.pump_hp_label}}",
  "Current pump power: {{vars.pump_connection_label}}",
  "Existing solar: {{vars.bat_existing_label}}",
  "Backup need: {{vars.bat_backup_label}}",
  "Backup appliances: {{vars.bat_appliances_label}}",
  "Battery property: {{vars.bat_property_label}}",
  "Monthly bill: {{vars.res_bill_label}}{{vars.com_bill_label}}",
  "Location: {{vars.city_label}}",
  "Roof / site: {{vars.res_roof_label}}{{vars.com_site_label}}{{vars.soc_rooftop_label}}",
  "Timeline: {{vars.timeline_label}}",
  "Callback: {{vars.callback_consent_label}}",
  "Callback time: {{vars.callback_time_label}}",
  "Priority: {{vars.lead_priority}} ({{vars.lead_score}} points)",
  "Score reasons: {{vars.lead_priority_reasons}}",
].join("\n");

// ------------------------------------------------------------
// Flow builder
// ------------------------------------------------------------

export interface LeadFlowNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
}

export interface LeadFlowDefinition {
  name: string;
  description: string;
  trigger_type: "first_inbound_message";
  trigger_config: { restart_keywords: string[] };
  fallback_policy: {
    on_unknown_reply: "reprompt";
    max_reprompts: number;
    on_timeout_hours: number;
    on_exhaust: "handoff";
  };
  entry_node_id: string;
  nodes: LeadFlowNode[];
}

export interface LeadFlowIds {
  /** custom field name → custom_fields.id */
  fields: Record<string, string>;
  /** tag name → tags.id (optional; tag steps are skipped when missing) */
  tags?: Record<string, string>;
}

const COL = 340;
const ROW = 200;

/** Build the full node graph. Pure — same input, same output. */
export function buildLeadFlow(ids: LeadFlowIds): LeadFlowDefinition {
  const nodes: LeadFlowNode[] = [];
  const add = (node_key: string, node_type: string, config: Record<string, unknown>, col: number, row: number) =>
    nodes.push({ node_key, node_type, config, position_x: col * COL, position_y: row * ROW });

  const questionNode = (
    key: string,
    q: Question,
    lang: Lang,
    next: string,
    col: number,
    row: number,
    routes: Record<string, string> = {},
  ) => {
    const target = (id: string) => routes[id] ?? next;
    if (q.kind === "list") {
      add(key, "send_list", {
        text: q.text[lang],
        button_label: (q === CALLBACK_TIME ? MESSAGES.callbackTimeButton : MESSAGES.chooseButton)[lang],
        footer_text: MESSAGES.answerFooter[lang],
        sections: [
          {
            rows: q.options.map((o) => ({
              reply_id: o.id,
              title: o.title[lang],
              ...(o.description ? { description: o.description[lang] } : {}),
              next_node_key: target(o.id),
            })),
          },
        ],
        save_as: q.key,
        text_reply_next: next,
      }, col, row);
    } else {
      add(key, "send_buttons", {
        text: q.text[lang],
        ...(q.kind === "buttons" ? { footer_text: MESSAGES.answerFooter[lang] } : {}),
        buttons: q.options.map((o) => ({ reply_id: o.id, title: o.title[lang], next_node_key: target(o.id) })),
        save_as: q.key,
        text_reply_next: next,
      }, col, row);
    }
  };

  add("start", "start", { next_node_key: "welcome" }, 0, 0);
  add("welcome", "send_buttons", {
    text: WELCOME_TEXT,
    buttons: LANGUAGE_OPTIONS.map((l) => ({ reply_id: l.id, title: l.title, next_node_key: `${l.lang}_category` })),
    save_as: "language",
  }, 1, 0);

  let row = 0;
  for (const lang of LANGS) {
    const confirmKey = `${lang}_confirm`;
    add(`${lang}_category`, "send_list", {
      text: MESSAGES.categoryPrompt[lang],
      button_label: MESSAGES.categoryButton[lang],
      sections: [
        {
          title: MESSAGES.categorySection[lang],
          rows: [
            ...CATEGORIES.map((c) => ({
              reply_id: c.id,
              title: c.title[lang],
              description: c.description[lang],
              next_node_key: `${lang}_${c.short}_1`,
            })),
            {
              reply_id: TALK_TO_SALES.id,
              title: TALK_TO_SALES.title[lang],
              description: TALK_TO_SALES.description[lang],
              next_node_key: `${lang}_talk_sales`,
            },
          ],
        },
      ],
      save_as: "solar_category",
    }, 2, row);
    add(`${lang}_talk_sales`, "send_message", {
      text: TALK_TO_SALES.reply[lang],
      next_node_key: "sales_request_crm",
    }, 3, row + CATEGORIES.length);

    for (const cat of CATEGORIES) {
      const questions = CATEGORY_QUESTIONS[cat.id];
      const nameCheck = `${lang}_${cat.short}_name_check`;
      questions.forEach((q, i) => {
        const next = i + 1 < questions.length ? `${lang}_${cat.short}_${i + 2}` : nameCheck;
        questionNode(`${lang}_${cat.short}_${i + 1}`, q, lang, next, 3 + i, row);
      });
      const tail = 3 + questions.length;
      add(nameCheck, "condition", {
        subject: "contact_field",
        subject_key: "name",
        operator: "present",
        true_next: confirmKey,
        false_next: `${lang}_${cat.short}_name`,
      }, tail, row);
      questionNode(`${lang}_${cat.short}_name`, NAME_QUESTION, lang, confirmKey, tail + 1, row);
      row += 1;
    }

    questionNode(confirmKey, CALLBACK_CONSENT, lang, "score", 11, row - 3, {
      callback_choose_time: `${lang}_callback_time`,
    });
    questionNode(`${lang}_callback_time`, CALLBACK_TIME, lang, "score", 12, row - 2);
    row += 1;
  }

  const field = (name: string) => {
    const id = ids.fields[name];
    if (!id) throw new Error(`Missing custom field id for "${name}"`);
    return `custom:${id}`;
  };
  const mapped = (target: string, key: string) => ({
    target,
    value: `{{vars.${key}}}`,
    value_map: crmValueMap(key),
  });

  add("score", "score_lead", { ...LEAD_SCORING, next_node_key: "crm_update" }, 13, 0);

  const tagNew = ids.tags?.[LEAD_FLOW_TAGS.newEnquiry];
  const tagHot = ids.tags?.[LEAD_FLOW_TAGS.hot];
  const afterCrm = tagNew ? "tag_new_enquiry" : tagHot ? "hot_check" : "lang_te_check";
  add("crm_update", "update_contact", {
    fields: [
      mapped("name", "customer_name"),
      mapped(field("Preferred language"), "language"),
      mapped(field("Solar requirement"), "solar_category"),
      mapped(field("Property type"), "res_property"),
      mapped(field("Property type"), "com_business"),
      mapped(field("Property type"), "bat_property"),
      mapped(field("Electricity bill amount"), "res_bill"),
      mapped(field("Electricity bill amount"), "com_bill"),
      mapped(field("Location"), "city"),
      mapped(field("Installation timeline"), "timeline"),
      mapped(field("Roof / site details"), "res_roof"),
      mapped(field("Roof / site details"), "com_site"),
      mapped(field("Roof / site details"), "soc_rooftop"),
      mapped(field("Callback preference"), "callback_consent"),
      mapped(field("Preferred callback time"), "callback_time"),
      { target: field("Lead priority"), value: "{{vars.lead_priority}}" },
      { target: field("Lead score"), value: "{{vars.lead_score}}" },
      {
        target: field("Qualification summary"),
        value: "{{vars.lead_priority}} · {{vars.lead_score}} points · {{vars.lead_priority_reasons}}",
      },
      { target: field("Lead source"), value: "WhatsApp" },
      { target: field("Lead status"), value: "New Lead" },
      { target: field("Follow-up date"), value: "{{today+1}}" },
    ],
    note: LEAD_NOTE,
    next_node_key: afterCrm,
  }, 14, 0);

  if (tagNew) {
    add("tag_new_enquiry", "set_tag", {
      mode: "add",
      tag_id: tagNew,
      next_node_key: tagHot ? "hot_check" : "lang_te_check",
    }, 15, 0);
  }
  if (tagHot) {
    add("hot_check", "condition", {
      subject: "var",
      subject_key: "lead_priority",
      operator: "equals",
      value: "HOT",
      true_next: "tag_hot_lead",
      false_next: "lang_te_check",
    }, 16, 0);
    add("tag_hot_lead", "set_tag", { mode: "add", tag_id: tagHot, next_node_key: "lang_te_check" }, 17, 0);
  }

  add("lang_te_check", "condition", {
    subject: "var",
    subject_key: "language",
    operator: "equals",
    value: languageReplyId("te"),
    true_next: "te_consent_check",
    false_next: "lang_hi_check",
  }, 18, 0);
  add("lang_hi_check", "condition", {
    subject: "var",
    subject_key: "language",
    operator: "equals",
    value: languageReplyId("hi"),
    true_next: "hi_consent_check",
    false_next: "en_consent_check",
  }, 18, 1);

  LANGS.forEach((lang, i) => {
    add(`${lang}_consent_check`, "condition", {
      subject: "var",
      subject_key: "callback_consent",
      operator: "equals",
      value: "callback_yes",
      true_next: `${lang}_final_callback`,
      false_next: `${lang}_time_check`,
    }, 19, i * 2);
    add(`${lang}_time_check`, "condition", {
      subject: "var",
      subject_key: "callback_time",
      operator: "present",
      true_next: `${lang}_final_callback`,
      false_next: `${lang}_final_not_now`,
    }, 20, i * 2);
    add(`${lang}_final_callback`, "send_message", { text: MESSAGES.finalCallback[lang], next_node_key: "handoff" }, 21, i * 2);
    add(`${lang}_final_not_now`, "send_message", { text: MESSAGES.finalNotNow[lang], next_node_key: "handoff" }, 21, i * 2 + 1);
  });

  add("sales_request_crm", "update_contact", {
    fields: [
      mapped(field("Preferred language"), "language"),
      mapped(field("Solar requirement"), "solar_category"),
      { target: field("Lead source"), value: "WhatsApp" },
      { target: field("Lead status"), value: "New Lead" },
      { target: field("Follow-up date"), value: "{{today+1}}" },
    ],
    note: "WhatsApp: customer asked to talk to the sales team (Suraj Solar flow)\nLanguage: {{vars.language_label}}",
    next_node_key: "handoff",
  }, 14, 2);

  add("handoff", "handoff", {
    note: "Suraj Solar lead qualification completed — answers, score and callback preference are on the contact.",
    assign_mode: "round_robin",
  }, 22, 0);

  return {
    name: LEAD_FLOW_NAME,
    description: LEAD_FLOW_DESCRIPTION,
    trigger_type: "first_inbound_message",
    trigger_config: { restart_keywords: [...RESTART_KEYWORDS] },
    fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 2, on_timeout_hours: 24, on_exhaust: "handoff" },
    entry_node_id: "start",
    nodes,
  };
}
