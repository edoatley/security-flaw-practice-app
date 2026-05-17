export type Tier = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

export interface AuthTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

export interface SnippetResponse {
  snippetId: string;
  title: string;
  language: string;
  owaspCategory: string;
  difficulty: Tier;
  lineCount: number;
  vulnerableLineCount: number;
  contentUrl: string;
  expiresAt: null;
  status?: never;
}

export interface TierCompleteResponse {
  status: "TIER_COMPLETE";
  tier: Tier;
  canReset: boolean;
}

export type GetSnippetResponse = SnippetResponse | TierCompleteResponse;

export interface SubmitRequest {
  snippetId: string;
  selectedLines: number[];
  timeTakenMs: number;
}

export interface SubmitResponse {
  correct: boolean;
  score: {
    rollingCorrectRate: number;
    rollingSpeedScore: number;
    compositeScore: number;
    windowSize: number;
  };
  tierChange: {
    previous: Tier;
    current: Tier;
    changed: boolean;
  };
  snippet?: {
    vulnerableLines: number[];
    owaspCategory: string;
    explanation: string;
  };
}

export interface ProgressResponse {
  userId: string;
  currentTier: Tier;
  totalAttempts: number;
  correctAttempts: number;
  lifetimeCorrectRate: number;
  rolling: {
    windowSize: number;
    correctRate: number;
    speedScore: number;
    compositeScore: number;
    attemptsUntilUpgrade: number | null;
    attemptsUntilDowngrade: number | null;
  };
  recentAttempts: Array<{
    snippetId: string;
    correct: boolean;
    tierId: Tier;
    timestamp: string;
  }>;
}

export type LineVisualState =
  | "default"
  | "selected"
  | "correct"
  | "incorrect"
  | "missed"
  | "unselected";
