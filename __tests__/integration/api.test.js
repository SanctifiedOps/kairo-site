import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import request from 'supertest';

// NOTE: These tests require the server to be running
// They test the actual API endpoints

describe('API Integration Tests', () => {
  const BASE_URL = 'http://localhost:8787';

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(BASE_URL)
        .get('/api/health')
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('services');
      expect(response.body.services).toHaveProperty('database');
      expect(response.body.services).toHaveProperty('ai_primary');
    });
  });

  describe('GET /api/status', () => {
    it('should return system status', async () => {
      const response = await request(BASE_URL)
        .get('/api/status')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('ok');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('provider');
    });
  });

  describe('GET /api/last', () => {
    it('should return the latest transmission', async () => {
      const response = await request(BASE_URL)
        .get('/api/last')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('cycleId');
      expect(response.body).toHaveProperty('transmission');
      expect(response.body).toHaveProperty('integrity');
      expect(response.body).toHaveProperty('stanceCounts');
    });
  });

  describe('GET /api/archive', () => {
    it('should return archived cycles', async () => {
      const response = await request(BASE_URL)
        .get('/api/archive')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('ok');
      expect(response.body).toHaveProperty('cycles');
      expect(Array.isArray(response.body.cycles)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const response = await request(BASE_URL)
        .get('/api/archive?limit=5')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body.cycles.length).toBeLessThanOrEqual(5);
    });

    it('should cap limit at 50', async () => {
      const response = await request(BASE_URL)
        .get('/api/archive?limit=100')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body.cycles.length).toBeLessThanOrEqual(50);
    });
  });

  describe('POST /api/stance', () => {
    it('should reject vote without wallet', async () => {
      const response = await request(BASE_URL)
        .post('/api/stance')
        .send({stance: 'ALIGN'})
        .expect(401)
        .expect('Content-Type', /json/);

      expect(response.body.error).toBe('WALLET_REQUIRED');
    });

    it('should reject vote without signature', async () => {
      const response = await request(BASE_URL)
        .post('/api/stance')
        .send({
          stance: 'ALIGN',
          wallet: 'test-wallet'
        })
        .expect(401)
        .expect('Content-Type', /json/);

      expect(response.body.error).toBe('SIGNATURE_REQUIRED');
    });

    it('should reject vote with invalid stance', async () => {
      const response = await request(BASE_URL)
        .post('/api/stance')
        .send({
          stance: 'INVALID',
          wallet: 'test-wallet',
          message: 'test',
          signature: 'test'
        })
        .expect(400)
        .expect('Content-Type', /json/);

      expect(response.body.error).toBe('INVALID_STANCE');
    });
  });

  describe('POST /api/admin/cycle', () => {
    it('should reject without admin key', async () => {
      const response = await request(BASE_URL)
        .post('/api/admin/cycle')
        .send({})
        .expect(401)
        .expect('Content-Type', /json/);

      expect(response.body.error).toBe('UNAUTHORIZED');
    });
  });
});
