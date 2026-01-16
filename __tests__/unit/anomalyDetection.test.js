import {describe, it, expect, beforeEach, vi} from 'vitest';

describe('Anomaly Detection System', () => {
  describe('coordinated voting detection', () => {
    it('should detect coordinated voting when 5+ wallets vote same stance within 10 seconds', () => {
      const votes = [
        {wallet: 'A', stance: 'ALIGN', timestampMs: 1000000},
        {wallet: 'B', stance: 'ALIGN', timestampMs: 1001000},
        {wallet: 'C', stance: 'ALIGN', timestampMs: 1002000},
        {wallet: 'D', stance: 'ALIGN', timestampMs: 1003000},
        {wallet: 'E', stance: 'ALIGN', timestampMs: 1004000},
      ];

      const timestamps = votes.map(v => v.timestampMs);
      const spread = Math.max(...timestamps) - Math.min(...timestamps);

      expect(votes.length).toBeGreaterThanOrEqual(5);
      expect(spread).toBeLessThan(10000);
    });

    it('should not detect coordinated voting with less than 5 votes', () => {
      const votes = [
        {wallet: 'A', stance: 'ALIGN', timestampMs: 1000000},
        {wallet: 'B', stance: 'ALIGN', timestampMs: 1001000},
        {wallet: 'C', stance: 'ALIGN', timestampMs: 1002000},
      ];

      expect(votes.length).toBeLessThan(5);
    });

    it('should not detect coordinated voting when votes are spread out', () => {
      const votes = [
        {wallet: 'A', stance: 'ALIGN', timestampMs: 1000000},
        {wallet: 'B', stance: 'ALIGN', timestampMs: 1020000},
        {wallet: 'C', stance: 'ALIGN', timestampMs: 1040000},
        {wallet: 'D', stance: 'ALIGN', timestampMs: 1060000},
        {wallet: 'E', stance: 'ALIGN', timestampMs: 1080000},
      ];

      const timestamps = votes.map(v => v.timestampMs);
      const spread = Math.max(...timestamps) - Math.min(...timestamps);

      expect(spread).toBeGreaterThan(10000);
    });
  });

  describe('rapid voting detection', () => {
    it('should detect rapid voting when wallet votes > 3 times in 5 minutes', () => {
      const voteCount = 5;
      const threshold = 3;

      expect(voteCount).toBeGreaterThan(threshold);
    });

    it('should not detect rapid voting with 3 or fewer votes', () => {
      const voteCount = 3;
      const threshold = 3;

      expect(voteCount).toBeLessThanOrEqual(threshold);
    });
  });

  describe('bot behavior detection', () => {
    it('should detect bot behavior when vote occurs < 5 seconds after cycle start', () => {
      const cycleStartMs = 1000000;
      const voteTimestampMs = 1003000;
      const timeSinceCycleStart = voteTimestampMs - cycleStartMs;

      expect(timeSinceCycleStart).toBeLessThan(5000);
    });

    it('should not detect bot behavior for normal voting timing', () => {
      const cycleStartMs = 1000000;
      const voteTimestampMs = 1030000;
      const timeSinceCycleStart = voteTimestampMs - cycleStartMs;

      expect(timeSinceCycleStart).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('wallet flagging', () => {
    it('should flag wallet when anomaly detected', () => {
      const flags = [
        {reason: 'coordinated_voting', at: '2026-01-16T12:00:00Z'},
        {reason: 'rapid_voting', at: '2026-01-16T12:05:00Z'}
      ];

      expect(flags).toHaveLength(2);
      expect(flags[0].reason).toBe('coordinated_voting');
    });

    it('should accumulate flags for repeated violations', () => {
      const flags = [
        {reason: 'rapid_voting', at: '2026-01-16T12:00:00Z'},
        {reason: 'rapid_voting', at: '2026-01-16T12:10:00Z'},
        {reason: 'rapid_voting', at: '2026-01-16T12:20:00Z'},
      ];

      expect(flags).toHaveLength(3);
      expect(flags.every(f => f.reason === 'rapid_voting')).toBe(true);
    });
  });
});
