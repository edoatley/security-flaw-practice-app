export type Tier = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

export interface AuthTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}
