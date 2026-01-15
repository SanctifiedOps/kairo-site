import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname,"dist");
const hasDist = fs.existsSync(distPath);
let db = null;
const fallbackTransmission = {
  primary:"RESIDUAL TRACE // ARRAY-04\nTHERMAL DRIFT: +0.7C\nCONTACT: NONE",
  secondary:"NO RESPONSE REQUIRED",
  integrity:"MED",
  at:new Date().toISOString()
};
const stanceLog = [];

const initFirebase = () => {
  if(!(process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_APPLICATION_CREDENTIALS)) return;
  try{
    admin.initializeApp({
      credential:admin.credential.applicationDefault(),
      projectId:process.env.FIREBASE_PROJECT_ID
    });
    db = admin.firestore();
  }catch(err){
    // fall back to memory storage if credentials are missing or invalid
    db = null;
  }
};

initFirebase();

if(hasDist){
  app.use(express.static(distPath));
}

app.get("/api/last", async (req,res) => {
  if(db){
    try{
      const snap = await db.collection("transmissions").orderBy("at","desc").limit(1).get();
      if(!snap.empty){
        const data = snap.docs[0].data();
        return res.json({
          primary:data?.primary || fallbackTransmission.primary,
          secondary:data?.secondary || "",
          integrity:data?.integrity || "LOW",
          at:data?.at || new Date().toISOString()
        });
      }
    }catch(err){
      // fallback below
    }
  }
  res.json(fallbackTransmission);
});

app.post("/api/stance", async (req,res) => {
  const payload = {
    stance:req.body?.stance || "UNKNOWN",
    at:req.body?.at || new Date().toISOString()
  };
  if(db){
    try{
      await db.collection("stances").add(payload);
      return res.json({ok:true});
    }catch(err){
      // fallback below
    }
  }
  stanceLog.push(payload);
  res.json({ok:true});
});

if(hasDist){
  app.get("*", (req,res) => {
    res.sendFile(path.join(distPath,"index.html"));
  });
}else{
  app.get("/", (req,res) => {
    res.json({status:"KAIRO online"});
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
