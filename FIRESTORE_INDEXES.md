# Firestore Indexes Configuration

## Required Indexes for KAIRO

This document specifies the Firestore composite indexes required for the KAIRO application to function correctly.

### Why Indexes Are Needed

Firestore requires composite indexes for queries that:
1. Order by a field and filter by another field
2. Filter by multiple fields
3. Use inequality operators on multiple fields

Without these indexes, queries will fail in production with error:
```
FAILED_PRECONDITION: The query requires an index
```

## Required Indexes

### 1. Stances Collection

**Index Name:** `stances_cycleId_stance`

**Purpose:** Used in `finalizeCycle()` to fetch all voters for a specific stance in a cycle.

**Fields:**
- `cycleId` (Ascending)
- `stance` (Ascending)

**Query that requires this index:**
```javascript
db.collection("stances")
  .where("cycleId", "==", cycleId)
  .where("stance", "==", option)
  .get();
```

**Location in code:** `server.js:1279` (function `fetchStancesByOption`)

---

### 2. Cycles Collection

**Index Name:** `cycles_cycleIndex_desc`

**Purpose:** Used in `/api/archive` to fetch recent cycles in reverse chronological order.

**Fields:**
- `cycleIndex` (Descending)

**Query that requires this index:**
```javascript
db.collection("cycles")
  .orderBy("cycleIndex", "desc")
  .limit(limit)
  .get();
```

**Location in code:** `server.js:1845` (GET `/api/archive` endpoint)

---

### 3. Events Collection (Optional but Recommended)

**Index Name:** `events_type_at`

**Purpose:** For querying events by type in chronological order (useful for analytics).

**Fields:**
- `type` (Ascending)
- `at` (Descending)

**Potential query:**
```javascript
db.collection("events")
  .where("type", "==", "CYCLE_CREATED")
  .orderBy("at", "desc")
  .limit(100)
  .get();
```

---

## How to Create Indexes

### Method 1: Firebase Console (Recommended for Production)

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Navigate to **Firestore Database** > **Indexes**
4. Click **Add Index**
5. Enter the following details for each index:

#### Index 1: stances_cycleId_stance
- Collection ID: `stances`
- Fields:
  - Field 1: `cycleId`, Order: Ascending
  - Field 2: `stance`, Order: Ascending
- Query scope: Collection

#### Index 2: cycles_cycleIndex_desc
- Collection ID: `cycles`
- Fields:
  - Field 1: `cycleIndex`, Order: Descending
- Query scope: Collection

### Method 2: firestore.indexes.json (Recommended for Version Control)

Create a file `firestore.indexes.json` in your project root:

```json
{
  "indexes": [
    {
      "collectionGroup": "stances",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "cycleId",
          "order": "ASCENDING"
        },
        {
          "fieldPath": "stance",
          "order": "ASCENDING"
        }
      ]
    },
    {
      "collectionGroup": "cycles",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "cycleIndex",
          "order": "DESCENDING"
        }
      ]
    },
    {
      "collectionGroup": "events",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "type",
          "order": "ASCENDING"
        },
        {
          "fieldPath": "at",
          "order": "DESCENDING"
        }
      ]
    }
  ],
  "fieldOverrides": []
}
```

Deploy with Firebase CLI:
```bash
firebase deploy --only firestore:indexes
```

### Method 3: Auto-Create from Error Links

When you get a "query requires an index" error in production:
1. The error message includes a direct link to create the index
2. Click the link (only works for project owners)
3. Confirm index creation
4. Wait 2-5 minutes for index to build

⚠️ **Warning:** This method is reactive and will cause downtime. Pre-create indexes instead.

## Index Build Time

- Small collections (<1000 docs): ~1-2 minutes
- Medium collections (1000-100k docs): ~5-15 minutes
- Large collections (>100k docs): ~30-60 minutes

During index building:
- Queries using that index will fail
- Other queries continue to work
- You can monitor build progress in Firebase Console

## Verifying Indexes

After creating indexes, verify they're active:

1. In Firebase Console, go to **Firestore Database** > **Indexes**
2. Check that status shows **Enabled** (not "Building")
3. Test queries in your application

Or use Firebase CLI:
```bash
firebase firestore:indexes
```

## Index Maintenance

### Monitoring
- Firestore charges for index storage (minimal cost)
- No ongoing maintenance required
- Indexes auto-update when documents change

### Cleanup
Remove unused indexes to save storage:
1. Identify queries no longer in use
2. Delete corresponding indexes
3. Monitor for errors after deletion

### Performance
- Indexes speed up reads, slightly slow down writes
- For KAIRO, write volume is low, so index overhead is negligible
- Maximum 200 indexes per database (KAIRO uses 2-3)

## Troubleshooting

### Error: "The query requires an index"
**Cause:** Index not created or still building
**Fix:** Create the index via console or JSON file

### Error: "Index creation failed"
**Cause:** Conflicting index exists
**Fix:** Delete conflicting index first, then recreate

### Query still fails after index created
**Cause:** Index still building
**Fix:** Wait 2-5 minutes, check status in console

### Index shows "Error" status
**Cause:** Field type mismatch or deleted field
**Fix:** Delete and recreate index with correct field paths

## Development vs Production

### Development
- Firestore emulator doesn't require indexes
- Queries work without indexes locally
- ⚠️ **Test with real Firestore before deploying to production**

### Production
- All indexes MUST be created before deployment
- Missing indexes = broken queries = downtime
- Create indexes as part of deployment pipeline

## Deployment Checklist

Before deploying KAIRO to production:

- [ ] All indexes created via Firebase Console or `firestore.indexes.json`
- [ ] Index status shows "Enabled" in Firebase Console
- [ ] Queries tested with production Firestore (not emulator)
- [ ] `firestore.indexes.json` committed to git for version control
- [ ] CI/CD pipeline includes `firebase deploy --only firestore:indexes`

## Additional Resources

- [Firestore Indexing Documentation](https://firebase.google.com/docs/firestore/query-data/indexing)
- [Index Best Practices](https://firebase.google.com/docs/firestore/best-practices)
- [Query Limitations](https://firebase.google.com/docs/firestore/quotas#indexes)
