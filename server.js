const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const NodeCache = require("node-cache");
require("dotenv").config(); 

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

app.get('/ping', (req, res) => {
  res.status(200).send('ok');
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// ====================== CLOUDINARY SETUP ======================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ dest: "uploads/" });

// ====================== SOCKET.IO ======================
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.join("reviewers");

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// ====================== MODELS ======================

const Pin = mongoose.model(
  "Pin",
  new mongoose.Schema({
    billboardId: String,
    latitude: Number,
    longitude: Number,
    country: String,
    addressShort: String,
    description: String,
    available: { type: Boolean, default: false },
  }),
);

const User = mongoose.model(
  "User",
  new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "company", "reviewer", "admin"], default: "user" },
    organizationName: { type: String, required: true }, // ✅ CHANGED: companyName → organizationName
    verified: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  }),
);

// ✅ FIXED CAMPAIGN MODEL - Matches client exactly
const Campaign = mongoose.model(
  "Campaign",
  new mongoose.Schema(
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      campaignName: { type: String, required: true }, // ✅ CHANGED: title → campaignName
      description: { type: String, required: true },
      organizationName: { type: String, required: true }, // ✅ From user account
      category: { type: String, required: true }, // ✅ ADDED
      targetLocation: { type: String, enum: ["local", "worldwide", "both"], required: true }, // ✅ ADDED
      uploadedCreative: { type: String, default: null }, // ✅ Cloudinary URL
      status: { type: String, enum: ["pending", "active", "completed"], default: "pending" },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
  ),
);

// ✅ FIXED UPLOAD MODEL - Added missing fields
const Upload = mongoose.model(
  "Upload",
  new mongoose.Schema(
    {
      campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      cloudinaryUrl: { type: String, required: true },
      publicId: { type: String, required: true },
      resourceType: { type: String, enum: ["image", "video"], required: true }, // ✅ ADDED
      format: { type: String, required: true },
      dimensions: { width: Number, height: Number },
      resolution: { type: String, required: true }, // ✅ ADDED
      aspectRatio: Number,
      length: Number,
      sizeBytes: { type: Number, required: true }, // ✅ ADDED
      daysSelected: Number,
      organizationName: { type: String, required: true }, // ✅ ADDED
      status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
      approvedAt: Date,
      reviewedAt: Date,
      declineReason: String,
      createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
  ),
);

// ✅ FIXED FAVORITE MODEL - pinId should be String, not ObjectId
const Favorite = mongoose.model(
  "Favorite",
  new mongoose.Schema(
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      pinId: { type: String, required: true }, // ✅ CHANGED: ObjectId → String
      billboardId: String, // ✅ ADDED
      latitude: Number, // ✅ ADDED
      longitude: Number, // ✅ ADDED
      address: String, // ✅ ADDED
      createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
  ),
);

// ====================== PLACEMENT MODEL ======================
const placementSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    uploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    pinId: { type: String, required: true },
    billboardId: { type: String }, // human-readable ID (e.g., ZA-JOH-1)
    pinDimensions: {
      width: Number,
      height: Number,
      unit: { type: String, default: 'px' },
      orientation: { type: String, enum: ['portrait', 'landscape', 'square'] }
    },
    daysSelected: { type: Number, required: true },
    startDate: { type: Date, required: true }, // will be set by client
    endDate: { type: Date, required: true },   // computed from startDate + daysSelected
    amountPaid: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'active', 'completed'], default: 'pending' },
    approvedAt: Date,
    reviewedAt: Date,
    declineReason: String,
    expiresAt: Date // for review deadline (24h after creation)
  },
  { timestamps: true }
);

// Indexes for fast queries
placementSchema.index({ campaignId: 1 });
placementSchema.index({ uploadId: 1 });
placementSchema.index({ status: 1 });
placementSchema.index({ userId: 1 });

const Placement = mongoose.model('Placement', placementSchema);

// Create unique index for favorites
Favorite.collection.createIndex({ userId: 1, pinId: 1 }, { unique: true });

// ====================== MIDDLEWARE ======================
function auth(req, res, next) {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `${role} only` });
    }
    next();
  };
}

// ====================== OPTIONAL AUTH MIDDLEWARE (NEW) ======================
const optionalAuth = (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    console.log("⚠️ No token - public/reviewer mode");
    return next();
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    console.log(`✅ Token OK → role: ${req.user.role}, userId: ${req.user.userId}`);
  } catch (err) {
    console.log("⚠️ Invalid/expired token");
  }
  next();
};

// ====================== AUTH ROUTES ======================

app.post("/api/auth/register", async (req, res) => {
  const { email, password, role, companyName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  // ✅ FIXED: organizationName is required
  const organizationName = role === "company" ? companyName : companyName || email.split("@")[0];

  if (!organizationName) {
    return res.status(400).json({ error: "Organization name required" });
  }

  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: "Email already exists" });

    const hashed = await bcrypt.hash(password, 12);

    const user = new User({
      email,
      passwordHash: hashed,
      role: role || "user",
      organizationName: organizationName, // ✅ CHANGED: companyName → organizationName
      verified: true,
    });

    await user.save();

    console.log("✓ User created:", user._id, "| Organization:", organizationName);

    res.status(201).json({
      message: "User created",
      userId: user._id,
      organizationName: user.organizationName,
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const accessToken = jwt.sign(
      { userId: user._id, role: user.role, organizationName: user.organizationName }, // ✅ ADDED organizationName to token
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    const refreshToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      accessToken,
      refreshToken,
      role: user.role,
      organizationName: user.organizationName, // ✅ ADDED
      message: "Login successful",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================== PIN ROUTES ======================

app.get("/api/pins", async (req, res) => {
  const cacheKey = "all_available_pins";
  let pins = cache.get(cacheKey);

  if (pins == null) {
    try {
      pins = await Pin.find({ available: true }).select(
        "_id billboardId latitude longitude country addressShort description",
      );
      cache.set(cacheKey, pins);
      console.log("Pins cached");
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    console.log("Pins from cache");
  }

  res.json(pins);
});

app.get("/api/pins/:id", async (req, res) => {
  const cacheKey = `pin_${req.params.id}`;
  let pin = cache.get(cacheKey);

  if (pin == null) {
    try {
      pin = await Pin.findById(req.params.id);
      if (!pin) return res.status(404).json({ error: "Not found" });
      cache.set(cacheKey, pin);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.json(pin);
});

app.post("/api/pins", auth, requireRole("company"), async (req, res) => {
  try {
    const newPin = new Pin({ ...req.body, available: false });
    await newPin.save();
    cache.del("all_available_pins");
    cache.del(`pin_${newPin._id}`);
    res.status(201).json(newPin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/pins/:id/approve", auth, requireRole("admin"), async (req, res) => {
  try {
    const pin = await Pin.findByIdAndUpdate(req.params.id, { available: true }, { new: true });
    if (!pin) return res.status(404).json({ error: "Not found" });
    cache.del("all_available_pins");
    cache.del(`pin_${req.params.id}`);
    res.json(pin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================== CAMPAIGN ROUTES (FIXED) ======================

// ✅ FIXED: Create campaign
app.post("/api/campaigns", auth, async (req, res) => {
  try {
    console.log("📥 Received campaign creation request:", req.body);

    const campaign = new Campaign({
      userId: req.user.userId,
      campaignName: req.body.campaignName, // ✅ FIXED: title → campaignName
      description: req.body.description,
      organizationName: req.user.organizationName, // ✅ FROM TOKEN, not request body
      category: req.body.category, // ✅ ADDED
      targetLocation: req.body.targetLocation, // ✅ ADDED
      uploadedCreative: req.body.uploadedCreative || null, // ✅ ADDED
      status: "pending",
    });

    await campaign.save();

    console.log("✓ Campaign created:", campaign._id);

    res.status(201).json({ success: true, campaign });
  } catch (err) {
    console.error("Campaign creation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ FIXED: Get all campaigns (company sees only own, reviewer sees all)
app.get("/api/campaigns", optionalAuth, async (req, res) => {
  try {
    let query = {};

    if (req.user) {
      if (req.user.role === 'reviewer' || req.user.role === 'admin') {
        console.log(`Reviewer/Admin ${req.user.userId} requested ALL campaigns`);
      } else {
        query.userId = req.user.userId;
        console.log(`Regular user ${req.user.userId} → only own campaigns`);
      }
    } else {
      console.log("No token → returning empty campaigns list");
      return res.json({ success: true, campaigns: [] });
    }

    const campaigns = await Campaign.find(query).sort({ createdAt: -1 });

    console.log(`✓ Sent ${campaigns.length} campaigns`);
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error("Get campaigns error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ FIXED: Get single campaign
app.get("/api/campaigns/:id", optionalAuth, async (req, res) => {
  try {
    let query = { _id: req.params.id };

    if (req.user) {
      if (req.user.role !== 'reviewer' && req.user.role !== 'admin') {
        query.userId = req.user.userId;
      }
    } else {
      return res.json({ success: true, campaign: null });
    }

    const campaign = await Campaign.findOne(query);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================== UPLOAD ROUTES (FIXED) ======================

// ✅ FIXED: Upload with all required fields
app.post("/api/uploads", auth, upload.single("file"), async (req, res) => {
  try {
    console.log("📥 Received upload request for campaign:", req.body.campaignId);

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!req.body.campaignId) {
      return res.status(400).json({ error: "campaignId is required" });
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      upload_preset: "Upload",
      resource_type: "auto",
    });

    console.log("✓ Uploaded to Cloudinary:", result.public_id);

    // Parse daysSelected (can be number or JSON string)
    let daysSelected = 7;
    if (req.body.daysSelected) {
      try {
        daysSelected =
          typeof req.body.daysSelected === "string"
            ? JSON.parse(req.body.daysSelected)
            : Number(req.body.daysSelected);
      } catch (e) {
        daysSelected = Number(req.body.daysSelected) || 7;
      }
    }

    const newUpload = new Upload({
      campaignId: req.body.campaignId,
      userId: req.user.userId,
      cloudinaryUrl: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type, // ✅ ADDED
      format: result.format,
      dimensions: { width: result.width, height: result.height },
      resolution: `${result.width}x${result.height}`, // ✅ ADDED
      aspectRatio: result.aspect_ratio,
      length: result.duration || null,
      sizeBytes: result.bytes, // ✅ ADDED
      daysSelected: daysSelected,
      organizationName: req.user.organizationName, // ✅ ADDED (from token)
      status: "pending",
    });

    await newUpload.save();

    console.log("✓ Upload saved:", newUpload._id);

    // ⚠️ UPDATE CAMPAIGN'S uploadedCreative FIELD
    await Campaign.findByIdAndUpdate(req.body.campaignId, {
      uploadedCreative: result.secure_url,
      updatedAt: new Date(),
    });

    console.log(`✓ Campaign ${req.body.campaignId} updated with creative URL`);

    // Emit socket event for reviewers
    io.to("reviewers").emit("new-upload", newUpload);

    // Clean up temp file
    require("fs").unlinkSync(req.file.path);

    res.status(201).json({ success: true, upload: newUpload });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Replace upload (fixed)
// ✅ NEW: Replace Upload → Create NEW upload (keep old one untouched)
app.put("/api/uploads/:id", auth, upload.single("file"), async (req, res) => {
  try {
    // 1. Find the OLD upload (we don't modify it)
    const oldUpload = await Upload.findById(req.params.id);
    if (!oldUpload) return res.status(404).json({ error: "Upload not found" });

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // 2. Upload new file to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      upload_preset: "Upload",
      resource_type: "auto",
    });

    // 3. Create BRAND NEW Upload document (new _id)
    const newUpload = new Upload({
      campaignId: oldUpload.campaignId,
      userId: req.user.userId,
      cloudinaryUrl: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      format: result.format,
      dimensions: { width: result.width, height: result.height },
      resolution: `\( {result.width}x \){result.height}`,
      aspectRatio: result.aspect_ratio,
      length: result.duration || null,
      sizeBytes: result.bytes,
      daysSelected: oldUpload.daysSelected,
      organizationName: req.user.organizationName,
      status: "pending",                    // new upload starts as pending again
    });

    await newUpload.save();

    console.log(`✓ Created NEW upload ${newUpload._id} (replacing old ${oldUpload._id})`);

    // 4. Update the Campaign to point to the NEW upload
    await Campaign.findByIdAndUpdate(oldUpload.campaignId, {
      uploadedCreative: result.secure_url,
      updatedAt: new Date(),
    });

    // Clean up temp file
    require("fs").unlinkSync(req.file.path);

    res.json({ success: true, upload: newUpload });   // return the NEW upload
  } catch (err) {
    console.error("Replace upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get uploads
app.get('/api/uploads', async (req, res) => {
  try {
    const { campaignId, status } = req.query;
    let query = {};
    if (campaignId) query.campaignId = campaignId;
    if (status) query.status = status;

    const uploads = await Upload.find(query)
      .populate('campaignId', 'campaignName organizationName description')
      .sort({ createdAt: -1 });

    const result = uploads.map(u => ({
      ...u.toObject(),
      campaign: u.campaignId,
      campaignId: u.campaignId._id
    }));

    res.json({ success: true, uploads: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve placement
// Approve placement + set correct endDate
app.put("/api/placements/:id/approve", async (req, res) => {
  try {
    const placement = await Placement.findById(req.params.id);
    if (!placement) return res.status(404).json({ error: "Placement not found" });

    const approvedAt = new Date();

    // Calculate endDate = approvedAt + daysSelected days
    const endDate = new Date(approvedAt);
    endDate.setDate(endDate.getDate() + placement.daysSelected);

    placement.status = "approved";
    placement.approvedAt = approvedAt;
    placement.endDate = endDate;           // ← THIS IS THE KEY
    placement.reviewedAt = new Date();

    await placement.save();

    console.log(`✓ Placement approved → endDate set to ${endDate}`);

    io.to("reviewers").emit("placement-updated", placement);

    res.json({ success: true, placement });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline placement
app.put("/api/placements/:id/decline", async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: "Decline reason is required" });

    const placement = await Placement.findById(req.params.id);
    if (!placement) return res.status(404).json({ error: "Placement not found" });

    placement.status = "rejected";
    placement.reviewedAt = new Date();
    placement.declineReason = reason;
    placement.approvedAt = undefined;

    await placement.save();

    console.log("✓ Placement declined:", placement._id);

    io.to("reviewers").emit("placement-updated", placement);

    res.json({ success: true, placement });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//======== PLACEMENTS =====

app.post('/api/placements', auth, async (req, res) => {
  try {
    const {
      campaignId,
      uploadId,
      pinId,
      billboardId,
      pinDimensions,
      daysSelected,
      startDate,
      amountPaid
    } = req.body;

    if (!campaignId || !uploadId || !pinId || !pinDimensions || !daysSelected || !startDate || !amountPaid) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify campaign belongs to user
    const campaign = await Campaign.findOne({ _id: campaignId, userId: req.user.userId });
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found or unauthorized' });
    }

    // Verify upload belongs to user
    const upload = await Upload.findOne({ _id: uploadId, userId: req.user.userId });
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found or unauthorized' });
    }

    // Compute endDate = startDate + daysSelected
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + daysSelected);

    // Expires for review (24h from now)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const placement = new Placement({
      campaignId,
      uploadId,
      userId: req.user.userId,
      pinId,
      billboardId,
      pinDimensions,
      daysSelected,
      startDate,
      endDate,
      amountPaid,
      status: 'pending',
      expiresAt
    });

    await placement.save();

    // Emit socket event (optional)
    io.to('reviewers').emit('new-placement', placement);

    res.status(201).json({ success: true, placement });
  } catch (err) {
    console.error('Placement creation error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ====================== GET PLACEMENTS (PUBLIC FOR TESTING) ======================
// ====================== GET PLACEMENTS (FIXED) ======================
// ====================== GET PLACEMENTS (WITH AUTO-EXPIRE from approvedAt) ======================
app.get('/api/placements', optionalAuth, async (req, res) => {
  try {
    // ────────────────────────────────────────────────
    // AUTO-EXPIRE: based on approvedAt + daysSelected days
    // ────────────────────────────────────────────────
    const now = new Date();
    const expiredCount = await Placement.updateMany(
      { 
        status: 'approved', 
        endDate: { $lt: new Date() } 
      },
      { 
        $set: { status: 'completed', updatedAt: new Date() } 
      }
    );

    if (expiredCount.modifiedCount > 0) {
      console.log(`✅ Auto-expired ${expiredCount.modifiedCount} placements`);
    }

    // ────────────────────────────────────────────────
    // Normal query + filtering (unchanged)
    // ────────────────────────────────────────────────
    const { status, campaignId, pinId } = req.query;
    let query = {};

    if (req.user) {
      if (req.user.role === 'reviewer' || req.user.role === 'admin') {
        console.log(`Reviewer/Admin requested ALL placements`);
      } else {
        query.userId = req.user.userId;
        console.log(`Regular user ${req.user.userId} → only own placements`);
      }
    } else {
      console.log("No token → Reviewer Dashboard mode: returning ALL placements");
    }

    if (status) query.status = status;
    if (campaignId) query.campaignId = campaignId;
    if (pinId) query.pinId = pinId;

    const placements = await Placement.find(query)
      .populate('campaignId', 'campaignName description organizationName category')
      .populate('uploadId', 'cloudinaryUrl dimensions format resourceType sizeBytes length')
      .sort({ createdAt: -1 });

    const result = placements.map(p => ({
      ...p.toObject(),
      campaign: p.campaignId,
      upload: p.uploadId,
      campaignId: p.campaignId?._id,
      uploadId: p.uploadId?._id
    }));

    console.log(`✅ Sent ${result.length} placements to frontend`);
    res.json({ success: true, placements: result });
  } catch (err) {
    console.error('Get placements error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/placements/:id', async (req, res) => {
  try {
    const placement = await Placement.findById(req.params.id)
      .populate('campaignId', 'campaignName description organizationName category')
      .populate('uploadId', 'cloudinaryUrl dimensions format resourceType sizeBytes length');

    if (!placement) return res.status(404).json({ error: 'Placement not found' });

    const result = {
      ...placement.toObject(),
      campaign: placement.campaignId,
      upload: placement.uploadId,
      campaignId: placement.campaignId?._id,
      uploadId: placement.uploadId?._id
    };

    res.json({ success: true, placement: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ====================== FAVORITES (FIXED) ======================

// ✅ FIXED: Favorites with all optional fields
app.post("/api/favorites", auth, async (req, res) => {
  try {
    const { pinId, billboardId, latitude, longitude, address } = req.body;

    console.log("📥 Received favorite request:", { pinId, billboardId });

    if (!pinId) {
      return res.status(400).json({ error: "pinId is required" });
    }

    // Check if already exists
    const existing = await Favorite.findOne({
      userId: req.user.userId,
      pinId: pinId,
    });

    if (existing) {
      console.log("⚠ Already favorited:", pinId);
      return res.status(200).json({
        success: true,
        message: "Already favorited",
        favorite: existing,
      });
    }

    const favorite = new Favorite({
      userId: req.user.userId,
      pinId: pinId,
      billboardId: billboardId, // ✅ ADDED
      latitude: latitude, // ✅ ADDED
      longitude: longitude, // ✅ ADDED
      address: address, // ✅ ADDED
    });

    await favorite.save();

    console.log("✓ Favorite saved:", favorite._id);

    res.status(201).json({ success: true, favorite });
  } catch (err) {
    console.error("Favorite error:", err);
    if (err.code === 11000) {
      return res.status(400).json({ error: "Already favorited" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/favorites/:pinId", auth, async (req, res) => {
  try {
    console.log("📥 Delete favorite request:", req.params.pinId);

    const result = await Favorite.findOneAndDelete({
      userId: req.user.userId,
      pinId: req.params.pinId,
    });

    if (!result) {
      console.log("⚠ Favorite not found:", req.params.pinId);
      return res.status(404).json({ error: "Favorite not found" });
    }

    console.log("✓ Favorite removed:", req.params.pinId);

    res.json({ success: true, message: "Removed from favorites" });
  } catch (err) {
    console.error("Delete favorite error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/favorites", auth, async (req, res) => {
  try {
    const favorites = await Favorite.find({ userId: req.user.userId }).sort({ createdAt: -1 });

    console.log(`✓ Fetched ${favorites.length} favorites`);

    res.json({ success: true, favorites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================== START SERVER ======================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = { app, server, io };
