/**
 * Get-Gitty Memes Workshop - Firebase Functions (Node 20)
 * Provides secure endpoints for: team registration, voting, stats, and admin controls.
 * Uses Secret Manager for ADMIN_SECRET and HASH_SALT (set via `firebase functions:secrets:set`).
 * NEW: Includes scheduled function to check GitHub for pushed memes.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler"); 
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const cors = require("cors");
const crypto = require("crypto");
const express = require("express");

// Initialize Admin SDK once
admin.initializeApp();
const db = admin.firestore();

// Secrets (best practice: Firebase Secret Manager)
const { defineSecret } = require("firebase-functions/params");
const ADMIN_SECRET = defineSecret("ADMIN_SECRET");
const HASH_SALT = defineSecret("HASH_SALT");
const GITHUB_TOKEN = defineSecret("GITHUB_TOKEN"); // NEW SECRET

// Utilities
const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

const slugify = (str) =>
  (str || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

const getClientFingerprint = (req, salt) => {
  // Prefer x-forwarded-for when behind a proxy
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim();
  const ua = (req.headers["user-agent"] || "").toString();
  return crypto.createHmac("sha256", salt).update(`${ip}::${ua}`).digest("hex");
};

const competitionRef = db.collection("meta").doc("competition");

/**
 * Public: Get all teams with basic info and leaderboard ordering.
 */
app.get("/teams", async (_req, res) => {
  try {
    const snap = await db.collection("teams").orderBy("votes", "desc").get();
    const teams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: teams });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to fetch teams" });
  }
});

/**
 * Public: Stats endpoint - counts, leaderboard top 10, time remaining & status
 */
app.get("/stats", async (_req, res) => {
  try {
    const [teamsSnap, competitionDoc] = await Promise.all([
      db.collection("teams").get(),
      competitionRef.get(),
    ]);

    let teamCount = teamsSnap.size;
    let memeCount = 0;
    let voteCount = 0;
    const teams = [];

    teamsSnap.forEach((doc) => {
      const d = doc.data() || {};
      memeCount += d.gitStages?.pushed ? 1 : 0; // UPDATED: Count teams with pushed memes
      voteCount += Number(d.votes || 0);
      teams.push({ id: doc.id, ...d });
    });

    teams.sort((a, b) => Number(b.votes || 0) - Number(a.votes || 0));
    const leaderboard = teams.slice(0, 10).map((t, i) => ({
      rank: i + 1,
      id: t.id,
      name: t.name,
      votes: Number(t.votes || 0),
    }));

    let status = "setup";
    let endTime = null;
    let timeRemaining = null;
    if (competitionDoc.exists) {
      const c = competitionDoc.data() || {};
      status = c.status || "setup";
      endTime = c.endTime || null;
      if (endTime) {
        const ms = endTime.toMillis() - Date.now();
        timeRemaining = Math.max(ms, 0);
      }
    }

    res.json({
      ok: true,
      data: { teamCount, memeCount, voteCount, leaderboard, status, endTime, timeRemaining },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to fetch stats" });
  }
});

/**
 * Public: Register a team (writes happen server-side only)
 */
app.post("/registerTeam", async (req, res) => {
  try {
    const { teamName, department, faculty, members = [], githubUsername } = req.body || {};
    if (!teamName || !department || !faculty || !githubUsername) {
      return res.status(400).json({ ok: false, error: "Missing required fields." });
    }
    if (!Array.isArray(members) || members.length !== 3) {
      return res.status(400).json({ ok: false, error: "Exactly 3 members are required." });
    }

    const repoName = `${slugify(teamName)}-meme-war`;
    const repoUrl = `https://github.com/${githubUsername}/${repoName}`;

    const teamDoc = {
      name: teamName,
      department,
      faculty,
      githubUsername: githubUsername,
      members: members.map((m, idx) => ({
        name: (m && m.name) || "",
        email: (m && m.email) || "",
        isLeader: idx === 0,
      })),
      repoName,
      repoUrl,
      votes: 0,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      gitStages: { staged: false, committed: false, pushed: false },
    };

    const ref = await db.collection("teams").add(teamDoc);
    res.json({ ok: true, data: { id: ref.id, repoName, repoUrl } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Registration failed" });
  }
});

/**
 * Public: Cast a vote for a team (rate-limited by hashed IP+UA)
 * One vote per fingerprint for the duration of the competition.
 */
app.post("/vote", async (req, res) => {
  try {
    const teamId = (req.body && req.body.teamId) || null;
    if (!teamId) return res.status(400).json({ ok: false, error: "teamId required" });

    // Ensure competition is running
    const cDoc = await competitionRef.get();
    const comp = cDoc.exists ? cDoc.data() || {} : {};
    if (!comp.status || comp.status !== "running") {
      return res.status(403).json({ ok: false, error: "Voting is not active." });
    }
    if (comp.endTime && comp.endTime.toMillis() < Date.now()) {
      return res.status(403).json({ ok: false, error: "Voting period has ended." });
    }

    // Fingerprint voter
    const salt = HASH_SALT.value();
    if (!salt) {
      console.error("HASH_SALT secret is not set.");
      return res.status(500).json({ ok: false, error: "Server not configured." });
    }
    const fingerprint = getClientFingerprint(req, salt);

    // Prevent duplicate voting
    const voteQuery = await db
      .collection("votes")
      .where("fingerprint", "==", fingerprint)
      .limit(1)
      .get();

    if (!voteQuery.empty) {
      return res.status(429).json({ ok: false, error: "You have already voted." });
    }

    // Transactionally persist vote and increment team counter
    await db.runTransaction(async (tx) => {
      const teamRef = db.collection("teams").doc(teamId);
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists) throw new Error("Team not found");

      tx.create(db.collection("votes").doc(), {
        teamId,
        fingerprint,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.update(teamRef, {
        votes: admin.firestore.FieldValue.increment(1),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ ok: true, data: { message: "Vote recorded" } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Voting failed" });
  }
});

/**
 * Admin: control competition (start, pause, end, resetVotes)
 * Provide secret via header `x-admin-secret: ...`
 */
app.post("/admin/:action", async (req, res) => {
  try {
    const action = req.params.action;
    const secret = req.headers["x-admin-secret"] || req.body?.secret;
    const adminSecret = ADMIN_SECRET.value();

    if (!adminSecret || secret !== adminSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (action === "start") {
      const { durationMinutes = 60 } = req.body || {};
      const endTime = admin.firestore.Timestamp.fromMillis(Date.now() + durationMinutes * 60 * 1000);
      await competitionRef.set({ status: "running", endTime }, { merge: true });
      return res.json({ ok: true, data: { status: "running", endTime } });
    }

    if (action === "pause") {
      await competitionRef.set({ status: "paused" }, { merge: true });
      return res.json({ ok: true, data: { status: "paused" } });
    }

    if (action === "end") {
      await competitionRef.set({ status: "ended" }, { merge: true });
      return res.json({ ok: true, data: { status: "ended" } });
    }

    if (action === "resetVotes") {
      // Reset votes & clear vote docs
      const teamsSnap = await db.collection("teams").get();
      const batch = db.batch();
      teamsSnap.forEach((doc) => batch.update(doc.ref, { votes: 0 }));
      await batch.commit();

      // Delete votes collection in chunks
      const votesSnap = await db.collection("votes").get();
      const deleteBatches = [];
      let subBatch = db.batch();
      let counter = 0;
      votesSnap.forEach((doc) => {
        subBatch.delete(doc.ref);
        counter++;
        if (counter === 400) { // avoid 500 writes/commit limit
          deleteBatches.push(subBatch.commit());
          subBatch = db.batch();
          counter = 0;
        }
      });
      deleteBatches.push(subBatch.commit());
      await Promise.all(deleteBatches);

      return res.json({ ok: true, data: { message: "Votes reset" } });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Admin action failed" });
  }
});

// =========================================================================
// NEW: SCHEDULED FUNCTION TO CHECK FOR PUSHED MEMES
// =========================================================================

const { Octokit } = require("@octokit/rest"); // GitHub API library

/**
 * Scheduled Function to check team repositories on GitHub.
 * Runs every 2 minutes to see if teams have pushed their code.
 */
/**
 * Scheduled Function to check team repositories on GitHub.
 * Runs every 2 minutes to see if teams have pushed their code.
 */
exports.checkRepos = onSchedule(
  {
    schedule: "every 2 minutes",
    secrets: [GITHUB_TOKEN],
    timeZone: "Europe/Helsinki",
  },
  async (event) => {
    console.log("🔍 Checking team repositories for pushed memes...");
    const octokit = new Octokit({ auth: GITHUB_TOKEN.value() });

    try {
      // 1. Fetch all teams from Firestore
      const teamsSnap = await db.collection("teams").get();
      console.log(`📋 Found ${teamsSnap.size} teams in database.`);
      const updatePromises = [];

      for (const teamDoc of teamsSnap.docs) {
        const teamId = teamDoc.id;
        const teamData = teamDoc.data();
        const { name, githubUsername, repoName, gitStages } = teamData;

        // Log the team we're checking
        console.log(`\n👨‍💻 Checking team: "${name}"`);
        console.log(`   Expected Repo: ${githubUsername}/${repoName}`);
        console.log(`   Current Status: pushed=${gitStages?.pushed}`);

        // Skip if already pushed or missing crucial info
        if (gitStages?.pushed) {
          console.log(`   ⏩ Skipping: Already marked as pushed.`);
          continue;
        }
        if (!githubUsername || !repoName) {
          console.log(`   ❌ Skipping: Missing githubUsername or repoName.`);
          continue;
        }

        try {
          // 2. Use GitHub API to check if the repo exists
          console.log(`   🌐 Attempting to find repo on GitHub...`);
          const { data: repo } = await octokit.repos.get({
            owner: githubUsername,
            repo: repoName,
          });
          console.log(`   ✅ Found repo: ${repo.html_url}`);

          // 3. Check for commits.
          console.log(`   🔍 Checking for commits...`);
          const { data: commits } = await octokit.repos.listCommits({
            owner: githubUsername,
            repo: repoName,
            per_page: 1,
          });

          // 4. If commits exist, update Firestore
          if (commits.length > 0) {
            const repoUrl = `https://${githubUsername}.github.io/${repoName}/`;
            console.log(`   🎉 Found ${commits.length} commit(s). Marking as PUSHED!`);
            console.log(`   🌐 Live URL: ${repoUrl}`);

            const updatePromise = teamDoc.ref.update({
              "gitStages.pushed": true,
              repoUrl: repoUrl,
              lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            });
            updatePromises.push(updatePromise);
          } else {
            console.log(`   ℹ️  Repo exists but has no commits.`);
          }
        } catch (error) {
          // If GitHub API throws a 404, the repo doesn't exist yet.
          if (error.status === 404) {
            console.log(`   ❌ Repo not found on GitHub. (404 Error)`);
          } else {
            // Log any other errors (e.g., rate limits, server errors)
            console.error(`   💥 GitHub API Error:`, error.message);
          }
        }
      }

      // 5. Wait for all Firestore updates to complete
      await Promise.all(updatePromises);
      console.log(`\n✅ Finished. Updated ${updatePromises.length} teams.`);
    } catch (error) {
      console.error("💥 Critical error in scheduled function:", error);
    }
  }
);

/**
 * Export the HTTPS function with secrets
 */
exports.api = onRequest(
  {
    secrets: [ADMIN_SECRET, HASH_SALT], // Original secrets
  },
  app
);// test
test
