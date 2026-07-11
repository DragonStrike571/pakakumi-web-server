/**
 * i18n — Minimal translation layer for Telegram messages.
 *
 * Supports English (en) and Swahili (sw) for key user-facing messages.
 * Channel messages (broadcast) stay in English since they go to mixed audiences.
 * DM messages (commands, replies) will use the user's preferred language.
 */

export type Language = "en" | "sw";

interface TranslationSet {
  // Hit proof
  targetHit: string;
  gameResult: string;
  trackRecord: string;
  todayLabel: string;
  premiumMembersGotThis: string;

  // Alerts
  newTargetAlert: string;
  whyLabel: string;
  expectedWindow: string;
  howSure: string;
  statusLabel: string;
  useBotToPlan: string;

  // Correlation
  correlationDetected: string;
  correlationExplain: (count: number) => string;
  targetsLiningUp: string;

  // Risk
  dangerWarning: string;
  safeMessage: string;

  // Subscription
  subscriptionExpired: string;
  subscriptionExpiredMsg: string;

  // General
  planMyBets: string;
  howItWorks: string;
  joinPremium: string;
}

const translations: Record<Language, TranslationSet> = {
  en: {
    targetHit: "TARGET HIT!",
    gameResult: "Game Result",
    trackRecord: "Our Track Record",
    todayLabel: "Today",
    premiumMembersGotThis: "Premium members got this alert before it happened.",
    newTargetAlert: "NEW TARGET ALERT",
    whyLabel: "Why",
    expectedWindow: "Expected Window",
    howSure: "How Sure",
    statusLabel: "Status",
    useBotToPlan: "Use the bot to plan your bets before you start.",
    correlationDetected: "AGGREGATE CORRELATION DETECTED",
    targetsLiningUp: "Several targets are lining up at the same time. This usually means a big round is coming soon.",
    correlationExplain: (count: number) =>
      `${count} targets are all waiting to be hit. When this many line up together, the chance of a big round is much higher. Plan your bets carefully.`,
    dangerWarning: "🚨 WARNING: Your money is too little for this target. You will lose it very quickly. Try a smaller target or add more cash.",
    safeMessage: "✅ SAFE: Follow these bets exactly and you have a good chance.",
    subscriptionExpired: "Subscription Expired",
    subscriptionExpiredMsg: "Your premium access has ended. You have been removed from the live channel.\n\nType /start to renew.",
    planMyBets: "💰 Plan My Bets",
    howItWorks: "📖 How It Works",
    joinPremium: "Join Premium",
  },
  sw: {
    targetHit: "SHABAHA IMEGONGWA!",
    gameResult: "Matokeo ya Mchezo",
    trackRecord: "Rekodi Yetu",
    todayLabel: "Leo",
    premiumMembersGotThis: "Wanachama wa Premium walipata arifa hii kabla haijatokea.",
    newTargetAlert: "ARIFA MPYA YA SHABAHA",
    whyLabel: "Kwa nini",
    expectedWindow: "Muda Unaotarajiwa",
    howSure: "Uhakika",
    statusLabel: "Hali",
    useBotToPlan: "Tumia bot kupanga dau zako kabla hujaanza.",
    correlationDetected: "MUUNGANIKO MKUBWA UMETAMBULIWA",
    targetsLiningUp: "Shabaha kadhaa zinajipanga kwa wakati mmoja. Hii kawaida inamaanisha raundi kubwa inakuja hivi karibuni.",
    correlationExplain: (count: number) =>
      `Shabaha ${count} zote zinasubiri kugongwa. Zinapojipanga pamoja hivi, nafasi ya raundi kubwa ni kubwa zaidi. Panga dau zako kwa uangalifu.`,
    dangerWarning: "🚨 ONYO: Pesa yako ni ndogo sana kwa shabaha hii. Utaipoteza haraka sana. Jaribu shabaha ndogo au ongeza pesa.",
    safeMessage: "✅ SALAMA: Fuata dau hizi kama zilivyo na una nafasi nzuri.",
    subscriptionExpired: "Usajili Umeisha",
    subscriptionExpiredMsg: "Ufikiaji wako wa premium umeisha. Umeondolewa kwenye channel ya moja kwa moja.\n\nAndika /start kuhuisha.",
    planMyBets: "💰 Panga Dau Zangu",
    howItWorks: "📖 Jinsi Inavyofanya Kazi",
    joinPremium: "Jiunge na Premium",
  },
};

/**
 * Get the translation set for a given language code.
 * Falls back to English for unknown languages.
 */
export function t(lang: string | undefined | null): TranslationSet {
  if (lang === "sw") return translations.sw;
  return translations.en;
}
