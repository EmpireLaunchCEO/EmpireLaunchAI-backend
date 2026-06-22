export interface PlatformMetrics {
  revenue: number; // In cents
  engagement: number; // Reach/Views
  adSpend: number; // In cents
  sentimentScore?: number; // 0-100
  breakdown: Record<string, any>;
}

export interface PlatformAdapter {
  getPlatformName(): string;
  fetchMetrics(userId: string, date: Date): Promise<PlatformMetrics>;
}
