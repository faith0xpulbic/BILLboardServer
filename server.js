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
const uploadMemory = multer({ storage: multer.memoryStorage() });

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
    referenceId: String,
    gisData: {
      type: {
        population: Number,
        environment: String,
        location: String,
        attributes: { type: [String], default: undefined },
        rwi: Number,
      },
      default: undefined,
    },
  }, { strict: false })  // <-- add this
);

const User = mongoose.model(
  "User",
  new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "company", "reviewer", "admin"], default: "user" },
    organizationName: { type: String, required: true },
    businessAbout: { type: String, default: null },
    verified: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  }),
);

const Campaign = mongoose.model(
  "Campaign",
  new mongoose.Schema(
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

      campaignName: { type: String, required: true },

      description: { type: String, required: true },

      organizationName: { type: String, required: true },

      category: { type: String, required: true },

      targetLocation: { type: String, enum: ["local", "worldwide", "both"], required: true },

      uploadedCreative: { type: String, default: null },

      // NEW: UI field from both flows (store it)
      targetAudience: { type: String, default: null },

      // NEW: UI field from both flows (store it)
      recommendationPriority: {
        type: String,
        enum: ["quality", "visibility", "balanced"],
        default: "balanced",
      },

      status: { type: String, enum: ["pending", "active", "completed"], default: "pending" },
    },
    { timestamps: true },
  ),
);

const Upload = mongoose.model(
  "Upload",
  new mongoose.Schema(
    {
      campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      cloudinaryUrl: { type: String, required: true },
      publicId: { type: String, required: true },
      resourceType: { type: String, enum: ["image", "video"], required: true },
      format: { type: String, required: true },
      dimensions: { width: Number, height: Number },
      resolution: { type: String, required: true },
      aspectRatio: Number,
      length: Number,
      sizeBytes: { type: Number, required: true },
      daysSelected: Number,
      organizationName: { type: String, required: true },
      status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
      approvedAt: Date,
      reviewedAt: Date,
      declineReason: String,
      refits: {
        type: Map,
        of: {
          cloudinaryUrl: String,
          publicId: String,
          dimensions: { width: Number, height: Number },
          createdAt: Date
        },
        default: new Map()
      },
      reanimations: {
        type: Map,
        of: {
          status: { type: String, enum: ["processing", "completed", "failed"] },
          videoUrl: String,
          publicId: String,
          durationSec: Number,
          width: Number,
          height: Number,
          elements: { type: Array, default: undefined },
          // Aspect ratio key this animation was generated for (e.g. "16:9")
          aspectRatio: String,
          // Whether the source creative was the original upload or its refit
          source: { type: String, enum: ["original", "refit"] },
          error: String,
          createdAt: Date
        },
        default: new Map()
      }
    },
    { timestamps: true }
  )
);

const Favorite = mongoose.model(
  "Favorite",
  new mongoose.Schema(
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      pinId: { type: String, required: true },
      collection: {
        name: { type: String, required: true, default: "Favorites" },
      },
      billboardId: String,
      latitude: Number,
      longitude: Number,
      address: String,
    },
    { timestamps: true },
  ),
);

Favorite.schema.index({ userId: 1, pinId: 1, "collection.name": 1 }, { unique: true });
// Prevent duplicates inside the same collection, but allow the same pin in 

// ====================== PLACEMENT MODEL ======================
const placementSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    uploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    pinId: { type: String, required: true },
    billboardId: { type: String },
    pinDimensions: {
      width: Number,
      height: Number,
      unit: { type: String, default: 'ft' },
      orientation: { type: String, enum: ['portrait', 'landscape', 'square'] }
    },
    refitSize: {
      size: { type: String },
      status: { type: String, enum: ['pending', 'completed'] }
    },
    daysSelected: { type: Number, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    amountPaid: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'active', 'completed'], default: 'pending' },
    approvedAt: Date,
    reviewedAt: Date,
    declineReason: String,
    expiresAt: Date
  },
  { timestamps: true }
);

const waitlistSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  createdAt: { type: Date, default: Date.now }
});

const Waitlist = mongoose.model('Waitlist', waitlistSchema);

// FIX: Register Placement model (was missing)
const Placement = mongoose.model('Placement', placementSchema);

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

const optionalAuth = (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    console.log("⚠️ No token - public/reviewer mode");
    return next();
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    console.log(`✅ Token OK → role: ${req.user.role}, userId: ${req.user.userId}`);
    return next();
  } catch (err) {
    // A token was presented but is invalid or expired → reject so the
    // client can detect session expiry instead of silently getting
    // empty/public data.
    console.log("⛔ Invalid/expired token → 401");
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ====================== AUTH ROUTES ======================

// POST /api/auth/register
app.post("/api/auth/register", async (req, res) => {
  const { email, password, role, companyName, businessAbout } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

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
      organizationName,
      businessAbout: businessAbout ?? null,
      verified: true,
    });

    await user.save();

    const accessToken = jwt.sign(
      { userId: user._id, role: user.role, organizationName: user.organizationName },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    const refreshToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.status(201).json({
      message: "User created",
      userId: user._id,
      accessToken,
      refreshToken,
      role: user.role,
      organizationName: user.organizationName,
      businessAbout: user.businessAbout,
    });
  } catch (err) {
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
      { userId: user._id, role: user.role, organizationName: user.organizationName },
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
      organizationName: user.organizationName,
      businessAbout: user.businessAbout,
      message: "Login successful",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/refresh
// Exchanges a valid refresh token for a fresh access token (+ rolled refresh token).
app.post("/api/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: "No refresh token" });

  const refreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!refreshSecret) {
    console.error("⛔ JWT_REFRESH_SECRET is not configured — refusing to refresh");
    return res.status(500).json({ error: "Server auth misconfigured" });
  }

  try {
    const decoded = jwt.verify(refreshToken, refreshSecret);

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: "User not found" });

    const accessToken = jwt.sign(
      { userId: user._id, role: user.role, organizationName: user.organizationName },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    const newRefreshToken = jwt.sign(
      { userId: user._id },
      refreshSecret,
      { expiresIn: "7d" },
    );

    res.json({
      accessToken,
      refreshToken: newRefreshToken,
      role: user.role,
      organizationName: user.organizationName,
      businessAbout: user.businessAbout,
      message: "Token refreshed",
    });
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select(
      "email role organizationName businessAbout verified createdAt",
    );

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//____WAITLIST_

app.post('/api/waitlist', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const entry = new Waitlist({ email });
    await entry.save();

    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Already subscribed' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ====================== PARTNER REQUEST MODEL ======================

const partnerRequestSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["media_owner", "ssp"],
    required: true,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  companyName: {
    type: String,
    required: true,
    trim: true,
  },
  country: {
    type: String,
    required: true,
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const PartnerRequest = mongoose.model("PartnerRequest", partnerRequestSchema);

// ====================== PARTNER REQUEST ROUTE ======================

app.post("/api/partner-requests", async (req, res) => {
  try {
    const { type, email, companyName, country } = req.body;

    // Validation
    if (!type || !["media_owner", "ssp"].includes(type)) {
      return res.status(400).json({ error: "Partner type must be 'media_owner' or 'ssp'" });
    }

    if (!email || !companyName || !country) {
      return res.status(400).json({ error: "Business email, company name, and country are required" });
    }

    // Save entry to MongoDB
    const partnerEntry = new PartnerRequest({
      type,
      email,
      companyName,
      country,
    });

    await partnerEntry.save();

    res.status(201).json({
      success: true,
      message: "Partner request received successfully",
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
        "_id billboardId latitude longitude country addressShort address description mainImageUrl horizontalImageUrl",
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

app.get('/api/uploads/:id', auth, async (req, res) => {
  try {
    const upload = await Upload.findById(req.params.id);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    if (upload.userId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json({ success: true, upload });
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

// ====================== UPLOAD ROUTES ======================

app.post('/api/uploads/:id/refits', auth, async (req, res) => {
  try {
    const { refitSize, cloudinaryUrl, publicId, dimensions } = req.body;

    const upload = await Upload.findById(req.params.id);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });

    if (upload.userId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    upload.refits.set(refitSize, {
      cloudinaryUrl,
      publicId,
      dimensions,
      createdAt: new Date()
    });

    await upload.save();

    res.json({ success: true, refit: upload.refits.get(refitSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/uploads", auth, upload.single("file"), async (req, res) => {
  try {
    console.log("📥 Received upload request for campaign:", req.body.campaignId);

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!req.body.campaignId) {
      return res.status(400).json({ error: "campaignId is required" });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      upload_preset: "Upload",
      resource_type: "auto",
    });

    console.log("✓ Uploaded to Cloudinary:", result.public_id);

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
      resourceType: result.resource_type,
      format: result.format,
      dimensions: { width: result.width, height: result.height },
      resolution: `${result.width}x${result.height}`,
      aspectRatio: result.aspect_ratio,
      length: result.duration || null,
      sizeBytes: result.bytes,
      daysSelected,
      organizationName: req.user.organizationName,
      status: "pending",
    });

    await newUpload.save();

    console.log("✓ Upload saved:", newUpload._id);

    await Campaign.findByIdAndUpdate(req.body.campaignId, {
      uploadedCreative: result.secure_url,
      updatedAt: new Date(),
    });

    console.log(`✓ Campaign ${req.body.campaignId} updated with creative URL`);

    io.to("reviewers").emit("new-upload", newUpload);

    require("fs").unlinkSync(req.file.path);

    res.status(201).json({ success: true, upload: newUpload });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/uploads/:id", auth, upload.single("file"), async (req, res) => {
  try {
    const oldUpload = await Upload.findById(req.params.id);
    if (!oldUpload) return res.status(404).json({ error: "Upload not found" });

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const result = await cloudinary.uploader.upload(req.file.path, {
      upload_preset: "Upload",
      resource_type: "auto",
    });

    const newUpload = new Upload({
      campaignId: oldUpload.campaignId,
      userId: req.user.userId,
      cloudinaryUrl: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      format: result.format,
      dimensions: { width: result.width, height: result.height },
      resolution: `${result.width}x${result.height}`,
      aspectRatio: result.aspect_ratio,
      length: result.duration || null,
      sizeBytes: result.bytes,
      daysSelected: oldUpload.daysSelected,
      organizationName: req.user.organizationName,
      status: "pending",
    });

    await newUpload.save();

    console.log(`✓ Created NEW upload ${newUpload._id} (replacing old ${oldUpload._id})`);

    await Campaign.findByIdAndUpdate(oldUpload.campaignId, {
      uploadedCreative: result.secure_url,
      updatedAt: new Date(),
    });

    require("fs").unlinkSync(req.file.path);

    res.json({ success: true, upload: newUpload });
  } catch (err) {
    console.error("Replace upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

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

// ====================== CAMPAIGN ROUTES ======================

app.post("/api/campaigns", auth, async (req, res) => {
  try {
    console.log("📥 Received campaign creation request:", req.body);

    const campaign = new Campaign({
      userId: req.user.userId,
      campaignName: req.body.campaignName,
      description: req.body.description,
      organizationName: req.user.organizationName,
      category: req.body.category,
      targetLocation: req.body.targetLocation,
      uploadedCreative: req.body.uploadedCreative || null,
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

app.patch("/api/campaigns/:id", auth, async (req, res) => {
  try {
    const { campaignName, uploadedCreative } = req.body;
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaignName !== undefined) campaign.campaignName = campaignName;
    if (uploadedCreative !== undefined) campaign.uploadedCreative = uploadedCreative;
    await campaign.save();
    console.log(`✓ Campaign ${campaign._id} updated`);
    res.json({ success: true, campaign });
  } catch (err) {
    console.error("Update campaign error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/campaigns/:id", auth, async (req, res) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const uploads = await Upload.find({ campaignId: req.params.id, userId: req.user.userId });
    for (const u of uploads) {
      try { await cloudinary.uploader.destroy(u.publicId); } catch (e) {}
      if (u.refits) { for (const [, refit] of u.refits) { try { if (refit.publicId) await cloudinary.uploader.destroy(refit.publicId); } catch (e) {} } }
      if (u.reanimations) { for (const [, reanim] of u.reanimations) { try { if (reanim.publicId && reanim.status === 'completed') await cloudinary.uploader.destroy(reanim.publicId, { resource_type: 'video' }); } catch (e) {} } }
    }
    await Upload.deleteMany({ campaignId: req.params.id, userId: req.user.userId });
    await Placement.deleteMany({ campaignId: req.params.id, userId: req.user.userId });
    await Campaign.deleteOne({ _id: req.params.id, userId: req.user.userId });
    console.log(`✓ Campaign ${req.params.id} deleted with ${uploads.length} uploads`);
    res.json({ success: true, message: "Campaign and all related data deleted" });
  } catch (err) {
    console.error("Delete campaign error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/uploads/:id", auth, async (req, res) => {
  try {
    const uploadDoc = await Upload.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!uploadDoc) return res.status(404).json({ error: "Upload not found" });
    try { await cloudinary.uploader.destroy(uploadDoc.publicId); } catch (e) {}
    if (uploadDoc.refits) { for (const [, refit] of uploadDoc.refits) { try { if (refit.publicId) await cloudinary.uploader.destroy(refit.publicId); } catch (e) {} } }
    if (uploadDoc.reanimations) { for (const [, reanim] of uploadDoc.reanimations) { try { if (reanim.publicId && reanim.status === 'completed') await cloudinary.uploader.destroy(reanim.publicId, { resource_type: 'video' }); } catch (e) {} } }
    const campaign = await Campaign.findOne({ _id: uploadDoc.campaignId, userId: req.user.userId });
    if (campaign && campaign.uploadedCreative === uploadDoc.cloudinaryUrl) {
      const nextUpload = await Upload.findOne({ campaignId: uploadDoc.campaignId, userId: req.user.userId, _id: { $ne: req.params.id } }).sort({ createdAt: -1 });
      campaign.uploadedCreative = nextUpload ? nextUpload.cloudinaryUrl : null;
      await campaign.save();
    }
    await Upload.deleteOne({ _id: req.params.id, userId: req.user.userId });
    console.log(`✓ Upload ${req.params.id} deleted`);
    res.json({ success: true, message: "Upload deleted" });
  } catch (err) {
    console.error("Delete upload error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ====================== PLACEMENT ROUTES ======================

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

    const campaign = await Campaign.findOne({ _id: campaignId, userId: req.user.userId });
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found or unauthorized' });
    }

    const upload = await Upload.findOne({ _id: uploadId, userId: req.user.userId });
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found or unauthorized' });
    }

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + daysSelected);

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

    io.to('reviewers').emit('new-placement', placement);

    res.status(201).json({ success: true, placement });
  } catch (err) {
    console.error('Placement creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/placements', optionalAuth, async (req, res) => {
  try {
    const expiredCount = await Placement.updateMany(
      { status: 'approved', endDate: { $lt: new Date() } },
      { $set: { status: 'completed', updatedAt: new Date() } }
    );

    if (expiredCount.modifiedCount > 0) {
      console.log(`✅ Auto-expired ${expiredCount.modifiedCount} placements`);
    }

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
      .populate('uploadId', 'cloudinaryUrl dimensions format resourceType sizeBytes length refits')
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
      .populate('uploadId', 'cloudinaryUrl dimensions format resourceType sizeBytes length refits');

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

app.put("/api/placements/:id/approve", async (req, res) => {
  try {
    const placement = await Placement.findById(req.params.id);
    if (!placement) return res.status(404).json({ error: "Placement not found" });

    const approvedAt = new Date();
    const endDate = new Date(approvedAt);
    endDate.setDate(endDate.getDate() + placement.daysSelected);

    placement.status = "approved";
    placement.approvedAt = approvedAt;
    placement.endDate = endDate;
    placement.reviewedAt = new Date();

    await placement.save();

    console.log(`✓ Placement approved → endDate set to ${endDate}`);

    io.to("reviewers").emit("placement-updated", placement);

    res.json({ success: true, placement });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ====================== FAVORITES ======================

app.post("/api/favorites", auth, async (req, res) => {
  try {
    const { pinId, billboardId, latitude, longitude, address } = req.body;
    const collectionName = req.body?.collection?.name || req.body?.name || "Favorites";

    if (!pinId) {
      return res.status(400).json({ error: "pinId is required" });
    }

    const existing = await Favorite.findOne({
      userId: req.user.userId,
      pinId,
      "collection.name": collectionName,
    });

    if (existing) {
      return res.status(200).json({
        success: true,
        message: "Already saved",
        favorite: existing,
      });
    }

    const favorite = new Favorite({
      userId: req.user.userId,
      pinId,
      collection: { name: collectionName },
      billboardId,
      latitude,
      longitude,
      address,
    });

    await favorite.save();
    res.status(201).json({ success: true, favorite });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Already saved in this collection" });
    }
    res.status(500).json({ error: err.message });
  }
});


app.delete("/api/favorites/:pinId", auth, async (req, res) => {
  try {
    const collectionName = req.query.name || "Favorites";

    const result = await Favorite.findOneAndDelete({
      userId: req.user.userId,
      pinId: req.params.pinId,
      "collection.name": collectionName,
    });

    if (!result) {
      return res.status(404).json({ error: "Favorite not found" });
    }

    res.json({ success: true, message: "Removed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/favorites", auth, async (req, res) => {
  try {
    const filter = { userId: req.user.userId };

    if (req.query.name) {
      filter["collection.name"] = req.query.name;
    }

    const favorites = await Favorite.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, favorites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================== REFIT SYSTEM ======================

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1", /*"1:4","1:8",*/ "2:3", "3:2", "3:4", /* "4:1", */ "4:3",
  "4:5", "5:4", /*"8:1",*/ "9:16", "16:9", "21:9"
]);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

const DEFAULT_SYSTEM_PROMPT = `You are an expert billboard creative adapter. Analyze the source advertisement image and identify its visual hierarchy:

1. PRIMARY FOCAL POINT: The main subject (product, person, or key visual element)
2. SECONDARY ELEMENTS: Supporting text, taglines, pricing
3. BRAND IDENTITY: Logos, brand names, social handles
4. BACKGROUND: Colors, textures, ambient elements

Your task:
- Redesign the composition to fill the EXACT canvas dimensions provided
- Preserve and EMPHASIZE the primary focal point — it must remain dominant and clear
- Reposition secondary text so it reads naturally in the new aspect ratio
- Keep logos and brand elements sharp and legible, never cropped
- Extend or fill background intelligently — match colors, patterns, and lighting seamlessly
- If upscaling is needed, preserve fine details and text crispness
- Fill the entire canvas edge-to-edge. NO letterboxing, NO centered crops, NO empty borders
- Maintain the original creative intent and brand aesthetic exactly

Output high-fidelity, print-ready quality.`;

const NATIVE_PATH_SYSTEM_PROMPT = `You are an expert billboard creative adapter. Analyze the source advertisement image and identify its visual hierarchy:

1. PRIMARY FOCAL POINT: The main subject (product, person, or key visual element)
2. SECONDARY ELEMENTS: Supporting text, taglines, pricing
3. BRAND IDENTITY: Logos, brand names, social handles
4. BACKGROUND: Colors, textures, ambient elements

Your task:
- Redesign the composition to Expand EXACTLY t the newly Requested Aspect ratio 
- Preserve and EMPHASIZE the primary focal point — it must remain dominant and clear
- Reposition secondary text so it reads naturally in the new aspect ratio
- Keep logos and brand elements sharp and legible, never cropped
- Extend or fill intelligently — match colors, patterns, and lighting seamlessly
- If upscaling is needed, preserve fine details and text crispness
- Fill the entirety to the new aspect ratio edge-to-edge. NO letterboxing, NO centered crops, NO black borders
- Maintain the original creative intent and brand aesthetic exactly
Output high-fidelity, print-ready quality.`;


// ── Utility functions ──────────────────────────────────────────────────────────

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x || 1;
}

function simplifyAspectRatio(width, height) {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function getReferenceCanvasDimensions(width, height) {
  const longestSide = Math.max(width, height);
  const targetLongestSide = Math.min(4096, Math.max(2048, Math.ceil(longestSide * 0.5)));
  const scale = targetLongestSide / longestSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const dataBuffer = Buffer.from(data);
  const lengthBuffer = Buffer.alloc(4);
  const crcBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(dataBuffer.length, 0);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, dataBuffer])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, dataBuffer, crcBuffer]);
}

function generateBlankPngBase64(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Invalid blank canvas size requested");
  }
  const rawImageData = Buffer.alloc((width + 1) * height);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const { deflateSync } = require("node:zlib");
  const png = Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", deflateSync(rawImageData)),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function getImageDimensionsFromBase64(base64String) {
  const buffer = Buffer.from(base64String, 'base64');

  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      format: 'png'
    };
  }

  // JPEG
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer[offset] === 0xFF) {
      if (buffer[offset + 1] === 0xC0 || buffer[offset + 1] === 0xC2) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          format: 'jpeg'
        };
      }
    }
    offset++;
  }

  return null;
}

// ── Aspect ratio tolerance check ──────────────────────────────────────────────

/**
 * Checks whether targetWidth x targetHeight matches a supported aspect ratio
 * exactly, within 5% tolerance, or not at all.
 *
 * Returns:
 *   exactMatch        — true if simplified ratio is in SUPPORTED_ASPECT_RATIOS (0% error)
 *   withinTolerance   — true if exactMatch OR closest supported ratio is within 5%
 *   bestSupportedRatio — the closest supported ratio string to use in imageConfig
 *   errorPct          — % error between target ratio and closest supported ratio
 */
function checkAspectRatioTolerance(targetWidth, targetHeight, tolerancePct = 5) {
  const targetRatio = targetWidth / targetHeight;
  const simplified = simplifyAspectRatio(targetWidth, targetHeight);
  const exactMatch = SUPPORTED_ASPECT_RATIOS.has(simplified);

  let bestMatch = null;
  let bestError = Infinity;

  for (const ratioStr of SUPPORTED_ASPECT_RATIOS) {
    const [w, h] = ratioStr.split(":").map(Number);
    const ratio = w / h;
    const error = Math.abs(targetRatio - ratio) / targetRatio;
    if (error < bestError) {
      bestError = error;
      bestMatch = ratioStr;
    }
  }

  const errorPct = bestError * 100;
  const withinTolerance = exactMatch || errorPct <= tolerancePct;

  return {
    exactMatch,
    withinTolerance,
    bestSupportedRatio: bestMatch,
    errorPct: parseFloat(errorPct.toFixed(3)),
  };
}

//pngscale

const sharp = require('sharp');

// (scaleToFitAspectRatio is defined once, below generateRefitWithGemini —
//  a previous duplicate here shadowed it and is removed.)

// ── Cloudinary upload helper ───────────────────────────────────────────────────

async function uploadRefitToCloudinary(imageBase64, mimeType, publicIdPrefix) {
  const { v4: uuidv4 } = require('uuid');
  const fs = require('fs');
  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  const tempPath = `uploads/refit_${uuidv4()}.${ext}`;

  fs.writeFileSync(tempPath, Buffer.from(imageBase64, 'base64'));

  try {
    const result = await cloudinary.uploader.upload(tempPath, {
      folder: "refits",
      public_id: `${publicIdPrefix}_refit_${Date.now()}`,
      resource_type: "image",
    });

    fs.unlinkSync(tempPath);

    return {
      cloudinaryUrl: result.secure_url,
      publicId: result.public_id,
      dimensions: { width: result.width, height: result.height },
    };
  } catch (err) {
    if (require('fs').existsSync(tempPath)) require('fs').unlinkSync(tempPath);
    throw err;
  }
}

// ── Core Gemini refit function ─────────────────────────────────────────────────

async function generateRefitWithGemini(imageUrl, targetWidth, targetHeight) {
  const apiKey = process.env.GEMINI_API_KEY;
  const overallStart = Date.now();

  // Download source image
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`Failed to download image: ${imageResponse.status}`);
  const imageBase64 = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
  const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

  // ── STEP 1: Check aspect ratio tolerance ──────────────────────────────────
  const ratioCheck = checkAspectRatioTolerance(targetWidth, targetHeight, 5);

  console.log("=== GEMINI REFIT REQUEST ===");
  console.log("Target:", targetWidth, "x", targetHeight);
  console.log("Requested ratio:", simplifyAspectRatio(targetWidth, targetHeight));
  console.log("Exact match:", ratioCheck.exactMatch);
  console.log("Within 5% tolerance:", ratioCheck.withinTolerance);
  console.log("Closest supported ratio:", ratioCheck.bestSupportedRatio);
  console.log("Error from closest:", ratioCheck.errorPct.toFixed(2) + "%");
  console.log("Generation path:", ratioCheck.withinTolerance ? "NATIVE (4K + imageConfig)" : "CANVAS FALLBACK");
  console.log("PNG refix:", ratioCheck.exactMatch ? "SKIP (exact match)" : "WILL RUN");

  // ── STEP 2: Canvas-fallback payload builder ────────────────────────────────
  // Strategy (validated against gemini-3-pro-image behaviour — the model
  // anchors output shape to the photographic input and ignores blank-canvas
  // hints):
  //   attempt 1 → [stretched-to-target original, pristine original] — stretched
  //               sets output geometry, pristine gives true proportions
  //   attempt 2 → [stretched] alone — purest geometry signal if attempt 1
  //               came back the wrong shape
  let referenceCanvas = null;
  let stretchedPart = null;

  const getStretchedPart = async () => {
    referenceCanvas = referenceCanvas || getReferenceCanvasDimensions(targetWidth, targetHeight);
    if (!stretchedPart) {
      const buf = await sharp(Buffer.from(imageBase64, "base64"))
        .resize(referenceCanvas.width, referenceCanvas.height, {
          fit: "fill",
          kernel: sharp.kernel.lanczos3,
        })
        .jpeg({ quality: 92 })
        .toBuffer();
      stretchedPart = { inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } };
      console.log(`📐 Pre-stretched source to ${referenceCanvas.width}x${referenceCanvas.height} (${simplifyAspectRatio(referenceCanvas.width, referenceCanvas.height)})`);
    }
    return stretchedPart;
  };

  const buildRequestBody = async (mode, correctionNote) => {
    if (ratioCheck.withinTolerance) {
      const finalPrompt = `${NATIVE_PATH_SYSTEM_PROMPT}

Target output size: ${targetWidth}x${targetHeight}px (${ratioCheck.bestSupportedRatio}).
Fill the canvas edge-to-edge with no borders.${correctionNote ? `\n\n${correctionNote}` : ""}`;

      return {
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: finalPrompt },
        ]}],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio: ratioCheck.bestSupportedRatio,
            imageSize: "2k",
          },
        },
      };
    }

    const stretched = await getStretchedPart();
    const orientationWord = targetWidth > targetHeight ? "WIDE LANDSCAPE" : "TALL PORTRAIT";
    const canvasPrompt =
      mode === "with_original"
        ? `${DEFAULT_SYSTEM_PROMPT}

Image 1 is this advertisement mechanically stretched to ${referenceCanvas.width}x${referenceCanvas.height}px to fit a ${orientationWord} billboard format.
Image 2 is the untouched original with TRUE proportions.

Redesign Image 1's composition so it looks completely natural at its exact current aspect ratio:
- Use Image 2 as the proportion reference — restore natural, undistorted shapes for every product, object and piece of typography
- Reflow and rebalance text across the full width; extend or rebuild the background seamlessly edge-to-edge
- Preserve brand identity, colours, message hierarchy and every element of the design

Output MUST be exactly ${referenceCanvas.width}x${referenceCanvas.height}px — the same shape as Image 1.${correctionNote ? `\n\n${correctionNote}` : ""}`
        : `${DEFAULT_SYSTEM_PROMPT}

This advertisement was mechanically stretched to ${referenceCanvas.width}x${referenceCanvas.height}px to fit a ${orientationWord} billboard format.

Redesign the composition so it looks completely natural at its exact current aspect ratio:
- Counteract the stretch — restore natural, undistorted shapes for every product, object and piece of typography
- Reflow and rebalance text across the full width; extend or rebuild the background seamlessly edge-to-edge
- Preserve brand identity, colours, message hierarchy and every element of the design

Output MUST remain exactly ${referenceCanvas.width}x${referenceCanvas.height}px — the same aspect ratio as the input image.${correctionNote ? `\n\n${correctionNote}` : ""}`;

    const parts =
      mode === "with_original"
        ? [stretched, { inlineData: { mimeType, data: imageBase64 } }, { text: canvasPrompt }]
        : [stretched, { text: canvasPrompt }];

    return {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
      },
    };
  };

  // ── STEP 3+4: Call Gemini, validate output aspect ratio, retry once ───────
  const projectId = "project-b275f288-bac3-429e-877";
  const region = "global";
  // gemini-3-pro-image-preview was shut down 2026-06-25 → use GA model
  const model = "gemini-3-pro-image";
  const targetAR = targetWidth / targetHeight;

  let generatedBase64 = null;
  let generatedMime = 'image/png';
  let geminiDims = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Attempt ladder: canvas path tries [stretched+original] first, then
    // [stretched] alone if the shape came back wrong.
    const mode = ratioCheck.withinTolerance
      ? "native"
      : attempt === 0 ? "with_original" : "stretched_only";

    let correctionNote = null;
    if (attempt > 0 && geminiDims) {
      correctionNote = `CRITICAL CORRECTION: Your previous output was ${geminiDims.width}x${geminiDims.height}px which is the WRONG orientation/aspect ratio. The required composition is ${referenceCanvas ? `${referenceCanvas.width}x${referenceCanvas.height}` : `${targetWidth}x${targetHeight}`}px (${targetWidth > targetHeight ? "WIDE LANDSCAPE" : "TALL PORTRAIT"}). Regenerate the full design at the correct aspect ratio.`;
      console.log(`⚠️ Gemini output AR mismatch (${geminiDims.width}x${geminiDims.height}) — retrying (mode: ${mode})`);
    }

    const requestBody = await buildRequestBody(mode, correctionNote);
    const geminiStart = Date.now();

    const response = await fetch(
      `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    if (!result.candidates?.[0]?.content?.parts) throw new Error("No content in Gemini response");

    generatedBase64 = null;
    for (const part of result.candidates[0].content.parts) {
      if (part.inlineData) {
        generatedBase64 = part.inlineData.data;
        generatedMime = part.inlineData.mimeType || 'image/png';
        break;
      }
    }
    if (!generatedBase64) throw new Error('No image generated by Gemini');

    geminiDims = getImageDimensionsFromBase64(generatedBase64);
    const geminiSizeBytes = Buffer.from(generatedBase64, 'base64').length;
    const arErrorPct = geminiDims
      ? (Math.abs((geminiDims.width / geminiDims.height) - targetAR) / targetAR * 100).toFixed(1)
      : '?';
    console.log(`📊 Gemini raw output (attempt ${attempt + 1}) — ${geminiDims?.width || '?'}x${geminiDims?.height || '?'} | AR error vs target: ${arErrorPct}% | ${(geminiSizeBytes/1024).toFixed(1)}KB | ${Date.now() - geminiStart}ms`);

    // Accept when output ratio is within 12% of the target ratio
    if (!geminiDims || Math.abs((geminiDims.width / geminiDims.height) - targetAR) / targetAR <= 0.12) break;
  }

  // Upload the RAW Gemini output for inspection/debugging
  try {
    const debugUpload = await uploadRefitToCloudinary(generatedBase64, generatedMime, `gemraw_${Date.now()}`);
    console.log(`🔍 RAW Gemini output (inspect): ${debugUpload.cloudinaryUrl}`);
  } catch (dbgErr) {
    console.warn('⚠️ Raw-output debug upload failed:', dbgErr.message);
  }

  // ── STEP 5: Refix to exact dimensions ─────────────────────────────────────
  // Exact native match → skip. Otherwise lock in the exact target dims.
  // Works on ANY output format now (sharp reads png/jpeg/webp alike).

  let finalBase64 = generatedBase64;
  let finalMime = generatedMime;
  const needsRefix = !ratioCheck.exactMatch;

  if (needsRefix) {
    const reason = !ratioCheck.withinTolerance ? 'canvas method' : 'approximated native ratio';
    console.log(`🖼  Running refix (reason: ${reason})...`);
    finalBase64 = await scaleToFitAspectRatio(generatedBase64, targetWidth, targetHeight);
    finalMime = 'image/jpeg';

    const finalDims = getImageDimensionsFromBase64(finalBase64);
    const finalSizeBytes = Buffer.from(finalBase64, 'base64').length;
    console.log(`✅ Refix complete — ${finalDims?.width || '?'}x${finalDims?.height || '?'} | ${(finalSizeBytes/1024).toFixed(1)}KB`);
  } else {
    console.log('✅ Exact native match — no refix needed');
  }

  const overallEnd = Date.now();
  console.log(`⏱️  Total refit time: ${overallEnd - overallStart}ms`);

  return {
    imageBase64: finalBase64,
    mimeType: finalMime,
    aspectRatio: simplifyAspectRatio(targetWidth, targetHeight),
    width: targetWidth,
    height: targetHeight,
    ratioPath: ratioCheck.withinTolerance ? 'native' : 'canvas',
    refixApplied: needsRefix,
  };
}

// ── Sharp resize helper ───────────────────────────────────────────────────────

// Cap the refix resolution — upscaling to full print size in-process took
// minutes on small CPUs. The stored refit keeps the EXACT aspect ratio at a
// capped size; delivery-side upscaling (Cloudinary) handles final print size.
const REFIX_MAX_SIDE = 2048;

async function scaleToFitAspectRatio(srcBase64, targetWidth, targetHeight) {
  const inputBuffer = Buffer.from(srcBase64, 'base64');
  const sharpStart = Date.now();

  let outW; let outH;
  const longest = Math.max(targetWidth, targetHeight);
  if (longest > REFIX_MAX_SIDE) {
    const s = REFIX_MAX_SIDE / longest;
    outW = Math.max(2, Math.round(targetWidth * s));
    outH = Math.max(2, Math.round(targetHeight * s));
  } else {
    outW = Math.round(targetWidth / 2) * 2;
    outH = Math.round(targetHeight / 2) * 2;
  }

  const srcMeta = await sharp(inputBuffer).metadata();
  console.log(`🔧 Sharp refix — src ${srcMeta.width}x${srcMeta.height} → ${outW}x${outH} (target ${targetWidth}x${targetHeight}, ${simplifyAspectRatio(targetWidth, targetHeight)})`);

  const outputBuffer = await sharp(inputBuffer)
    .resize(outW, outH, {
      fit: 'fill',      // squeeze/stretch to the EXACT locked-in ratio
      kernel: sharp.kernel.lanczos3
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  console.log(`🔧 Sharp refix done — ${outW}x${outH} | ${Date.now() - sharpStart}ms`);

  return outputBuffer.toString('base64');
}


// ====================== REFIT ENDPOINTS ======================

// AUTH TEST ENDPOINT — full Gemini flow, takes Cloudinary URL
// POST /api/refit/test
// Body: { imageUrl, targetWidth, targetHeight }
app.post('/api/refit/test', auth, async (req, res) => {
  try {
    const { imageUrl, targetWidth, targetHeight } = req.body;

    if (!imageUrl || !targetWidth || !targetHeight) {
      return res.status(400).json({ error: 'Missing imageUrl, targetWidth, or targetHeight' });
    }

    console.log("=== REFIT TEST ===");
    console.log("Image:", imageUrl);
    console.log("Target:", targetWidth, "x", targetHeight);

    const refitResult = await generateRefitWithGemini(
      imageUrl,
      parseInt(targetWidth),
      parseInt(targetHeight)
    );

    const cloudinaryResult = await uploadRefitToCloudinary(
      refitResult.imageBase64,
      refitResult.mimeType,
      "test"
    );

    res.json({
      success: true,
      refit: {
        cloudinaryUrl: cloudinaryResult.cloudinaryUrl,
        publicId: cloudinaryResult.publicId,
        dimensions: cloudinaryResult.dimensions,
        aspectRatio: refitResult.aspectRatio,
        ratioPath: refitResult.ratioPath,
        refixApplied: refitResult.refixApplied,
      }
    });

  } catch (err) {
    console.error("Refit test error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PREVIEW ENDPOINT — generate refit and cache on upload
// POST /api/refit/preview
// Body: { uploadId, targetWidth, targetHeight }
app.post('/api/refit/preview', auth, async (req, res) => {
  try {
    const { uploadId, targetWidth, targetHeight } = req.body;

    if (!uploadId || !targetWidth || !targetHeight) {
      return res.status(400).json({ error: 'Missing uploadId, targetWidth, or targetHeight' });
    }

    const upload = await Upload.findOne({ _id: uploadId, userId: req.user.userId });
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const targetAspectRatio = simplifyAspectRatio(parseInt(targetWidth), parseInt(targetHeight));

    // Return cached refit if it exists
    if (upload.refits?.has(targetAspectRatio)) {
      const existing = upload.refits.get(targetAspectRatio);
      return res.json({ success: true, refit: existing, cached: true });
    }

    const refitResult = await generateRefitWithGemini(
      upload.cloudinaryUrl,
      parseInt(targetWidth),
      parseInt(targetHeight)
    );

    const cloudinaryResult = await uploadRefitToCloudinary(
      refitResult.imageBase64,
      refitResult.mimeType,
      upload.publicId
    );

    const refitData = {
      cloudinaryUrl: cloudinaryResult.cloudinaryUrl,
      publicId: cloudinaryResult.publicId,
      dimensions: cloudinaryResult.dimensions,
      createdAt: new Date()
    };

    upload.refits.set(targetAspectRatio, refitData);
    await upload.save();

    res.json({ success: true, refit: refitData, cached: false });

  } catch (err) {
    console.error("Refit preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PLACEMENT ENDPOINT — generate refit, cache on upload, update placement
// POST /api/refit/placement
// Body: { placementId, targetWidth, targetHeight }
app.post('/api/refit/placement', auth, async (req, res) => {
  try {
    const { placementId, targetWidth, targetHeight } = req.body;

    if (!placementId || !targetWidth || !targetHeight) {
      return res.status(400).json({ error: 'Missing placementId, targetWidth, or targetHeight' });
    }

    const placement = await Placement.findOne({ _id: placementId, userId: req.user.userId });
    if (!placement) {
      return res.status(404).json({ error: 'Placement not found' });
    }

    const upload = await Upload.findOne({ _id: placement.uploadId, userId: req.user.userId });
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const targetAspectRatio = simplifyAspectRatio(parseInt(targetWidth), parseInt(targetHeight));

    let refitData;
    if (upload.refits?.has(targetAspectRatio)) {
      refitData = upload.refits.get(targetAspectRatio);
    } else {
      const refitResult = await generateRefitWithGemini(
        upload.cloudinaryUrl,
        parseInt(targetWidth),
        parseInt(targetHeight)
      );

      const cloudinaryResult = await uploadRefitToCloudinary(
        refitResult.imageBase64,
        refitResult.mimeType,
        upload.publicId
      );

      refitData = {
        cloudinaryUrl: cloudinaryResult.cloudinaryUrl,
        publicId: cloudinaryResult.publicId,
        dimensions: cloudinaryResult.dimensions,
        createdAt: new Date()
      };

      upload.refits.set(targetAspectRatio, refitData);
      await upload.save();
    }

    placement.refitSize = { size: targetAspectRatio, status: 'completed' };
    await placement.save();

    res.json({
      success: true,
      refit: refitData,
      placement: {
        _id: placement._id,
        refitSize: placement.refitSize
      }
    });

  } catch (err) {
    console.error("Refit placement error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PNG SCALE TEST (NO AUTH) — test pure PNG scaler in isolation, no Gemini
// POST /api/refit/png-scale-test
// multipart: image (PNG file), targetWidth, targetHeight
app.post('/api/refit/png-scale-test', uploadMemory.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    if (!req.file.mimetype.includes('png')) {
      return res.status(400).json({ error: 'Input must be PNG for this endpoint' });
    }

    const targetWidth = parseInt(req.body.targetWidth);
    const targetHeight = parseInt(req.body.targetHeight);

    if (!targetWidth || !targetHeight || targetWidth < 1 || targetHeight < 1) {
      return res.status(400).json({ error: 'Invalid targetWidth or targetHeight' });
    }

    console.log('\n========================================');
    console.log('🔬 PNG SCALE TEST');
    console.log('========================================');
    console.log('File:', req.file.originalname, '|', req.file.size, 'bytes');
    console.log('Target:', targetWidth, 'x', targetHeight);

    const srcBase64 = req.file.buffer.toString('base64');
    const inputDims = getImageDimensionsFromBase64(srcBase64);
    console.log('Input dims:', inputDims?.width, 'x', inputDims?.height);

    const startTime = Date.now();
    const scaledBase64 = pngScaleToFit(srcBase64, targetWidth, targetHeight);
    const processingMs = Date.now() - startTime;

    const outputDims = getImageDimensionsFromBase64(scaledBase64);
    console.log('Output dims:', outputDims?.width, 'x', outputDims?.height);
    console.log('Time:', processingMs + 'ms');

    res.json({
      success: true,
      result: {
        imageBase64: scaledBase64,
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${scaledBase64}`,
        input: {
          width: inputDims?.width,
          height: inputDims?.height,
          aspectRatio: inputDims ? (inputDims.width / inputDims.height).toFixed(4) : null,
        },
        output: {
          width: outputDims?.width,
          height: outputDims?.height,
          aspectRatio: outputDims ? (outputDims.width / outputDims.height).toFixed(4) : null,
        },
        target: {
          width: targetWidth,
          height: targetHeight,
          aspectRatio: (targetWidth / targetHeight).toFixed(4),
        },
        processingMs,
      }
    });

  } catch (err) {
    console.error('❌ PNG scale test error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================== REANIMATE SYSTEM ======================

// Takes a static creative, detects interesting elements (text / objects) with
// Gemini, cuts them out (Gemini image edit + magenta chroma key), then renders
// a looping MP4 where each element animates in over 2s and settles:
//   text    → slide from right / wiggle / scale bounce
//   objects → damped-sine bounce

// ── Constants ─────────────────────────────────────────────────────────────────

// Gemini models — preview variants were shut down 2026-06-25; these are GA.
// Image editing/generation: gemini-3.1-flash-image (Nano Banana 2).
// Vision/JSON detection:    gemini-3.7-flash.
// Refit (print-quality generation): gemini-3-pro-image (Nano Banana Pro).
const GEMINI_FLASH_MODEL = "gemini-3.7-flash";
const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

const REANIM_FPS = 30;
const REANIM_DURATION_S = 10;      // total video length
const REANIM_ENTRANCE_S = 2;       // window in which all effects animate + settle
const REANIM_SLIDE_T1_S = 1.2;     // slide-from-right travel time
const REANIM_MAX_ELEMENTS = 3;
const REANIM_MAX_SIDE = 1280;      // render canvas cap for speed
const REANIM_CACHE_KEY = "default";

const REANIM_DETECTION_PROMPT = `You are a motion director for billboard advertisements. Analyze the advertisement image and pick the most visually interesting elements to animate.

Rules:
- Select at most ${REANIM_MAX_ELEMENTS} elements. Fewer is fine.
- Good candidates: product objects (cup, bottle, phone), headline text blocks, taglines, price tags, logos.
- NEVER select: people, faces, hands, body parts, or the background.
- Each element must occupy at least 1% of the image area. Skip tiny details.
- Do not select elements that overlap each other heavily.

Effect assignment:
- "object" type → effect must be "bounce".
- "text" type → choose ONE of "slide_right" (best for headlines/taglines), "wiggle" (short punchy words, badges), or "scale_bounce" (prices, CTAs, short emphasis words).

Bounding box format: [ymin, xmin, ymax, xmax] with all values normalized 0-1000 relative to image dimensions.`;

const REANIM_CLEAN_PLATE_PROMPT = (labels) => `Edit this advertisement image. Completely remove the following elements and reconstruct the background behind them naturally so no trace remains: ${labels.join(", ")}.

Keep everything else EXACTLY identical: same framing, same camera position, same resolution and aspect ratio, same colors, same lighting, same remaining text and objects pixel-for-pixel. Only remove the listed elements and fill in the background behind them seamlessly.`;

const REANIM_CUTOUT_PROMPT = (label) => `Edit this advertisement image. Output the SAME image with the SAME framing, composition, camera position, aspect ratio and resolution — but replace EVERYTHING EXCEPT the ${label} with flat pure solid magenta color #FF00FF.

The ${label} itself must remain completely untouched at its exact original position, scale, orientation and appearance. Every other pixel must become pure flat #FF00FF magenta with no gradients, no shadows, no anti-aliasing halos around the ${label}.`;

// ── Gemini helpers ────────────────────────────────────────────────────────────

function reanimGeminiUrl(model) {
  const projectId = "project-b275f288-bac3-429e-877";
  return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

async function fetchImageAsBuffer(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Vision model call returning structured JSON element plan
async function detectReanimateElements(imageBase64, mimeType) {
  const requestBody = {
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType, data: imageBase64 } },
      { text: REANIM_DETECTION_PROMPT },
    ]}],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          elements: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                type: { type: "STRING", enum: ["text", "object"] },
                label: { type: "STRING" },
                effect: { type: "STRING", enum: ["bounce", "wiggle", "scale_bounce", "slide_right"] },
                bbox: { type: "ARRAY", items: { type: "INTEGER" } },
              },
              required: ["type", "label", "effect", "bbox"],
            },
          },
        },
        required: ["elements"],
      },
    },
  };

  const response = await fetch(reanimGeminiUrl(GEMINI_FLASH_MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(`Gemini detection error (${response.status}): ${await response.text()}`);
  }

  const result = await response.json();
  const textPart = result.candidates?.[0]?.content?.parts?.find((p) => p.text);
  if (!textPart) throw new Error("No JSON content in Gemini detection response");

  let parsed;
  try { parsed = JSON.parse(textPart.text); }
  catch { throw new Error("Gemini detection returned invalid JSON"); }

  // Post-process: clamp bboxes, drop tiny/heavily-overlapping elements, cap count
  const cleaned = [];
  for (const el of Array.isArray(parsed.elements) ? parsed.elements : []) {
    if (!Array.isArray(el.bbox) || el.bbox.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = el.bbox.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)));
    const areaPct = ((ymax - ymin) * (xmax - xmin)) / 10000;
    if (areaPct < 1) continue;
    if (cleaned.length >= REANIM_MAX_ELEMENTS) break;

    let overlaps = false;
    for (const kept of cleaned) {
      const ix = Math.max(0, Math.min(xmax, kept.bbox[3]) - Math.max(xmin, kept.bbox[1]));
      const iy = Math.max(0, Math.min(ymax, kept.bbox[2]) - Math.max(ymin, kept.bbox[0]));
      const inter = ix * iy;
      const union = areaPct + (((kept.bbox[2] - kept.bbox[0]) * (kept.bbox[3] - kept.bbox[1])) / 10000) - inter;
      if (union > 0 && inter / union > 0.35) { overlaps = true; break; }
    }
    if (overlaps) continue;

    cleaned.push({
      type: el.type === "object" ? "object" : "text",
      label: String(el.label || (el.type === "object" ? "object" : "text")).slice(0, 60),
      effect: el.type === "object" ? "bounce" : (["slide_right", "wiggle", "scale_bounce"].includes(el.effect) ? el.effect : "slide_right"),
      bbox: [ymin, xmin, ymax, xmax],
    });
  }

  return cleaned;
}

// Image-editing model call — returns generated image base64.
// Wrapped with a GLOBAL single-slot queue + 429 backoff: Vertex image quotas
// are per-project-per-minute and shared across ALL users, so concurrent jobs
// must line up here instead of colliding into RESOURCE_EXHAUSTED errors.
let geminiImageActive = 0;
const geminiImageQueue = [];

async function acquireGeminiImageSlot() {
  if (geminiImageActive < 1) { geminiImageActive += 1; return; }
  await new Promise((resolve) => geminiImageQueue.push(resolve));
  geminiImageActive += 1;
}

function releaseGeminiImageSlot() {
  geminiImageActive -= 1;
  const next = geminiImageQueue.shift();
  if (next) next();
}

async function generateReanimImage(parts, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await acquireGeminiImageSlot();
    try {
      return await generateReanimImageOnce(parts);
    } catch (err) {
      lastErr = err;
      const isQuota = /429|RESOURCE_EXHAUSTED/i.test(err.message || "");
      if (!isQuota || attempt === attempts - 1) throw err;
      const delayMs = 10000 * (attempt + 1);
      console.warn(`⚠️ Gemini image quota hit — backing off ${delayMs}ms (retry ${attempt + 1}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      releaseGeminiImageSlot();
    }
  }
  throw lastErr;
}

async function generateReanimImageOnce(parts) {
  const response = await fetch(reanimGeminiUrl(GEMINI_IMAGE_MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini image error (${response.status}): ${await response.text()}`);
  }

  const result = await response.json();
  for (const part of result.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData?.data) {
      return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" };
    }
  }
  throw new Error("No image in Gemini edit response");
}

// ── Cutout helpers (magenta chroma key via sharp) ─────────────────────────────

async function chromaKeyMagenta(inputBuffer) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // Distance from pure magenta (255, 0, 255)
    const dist = Math.sqrt((255 - r) ** 2 + g ** 2 + (255 - b) ** 2);
    if (dist < 110) {
      data[i + 3] = 0;
    } else if (dist < 175) {
      // Soft edge feather between the thresholds
      data[i + 3] = Math.round(data[i + 3] * ((dist - 110) / 65));
    }
  }

  return sharp(data, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

// Generate an aligned transparent cutout of one element, cropped to its bbox.
// Returns { buffer, left, top, width, height } in canvas coordinates, or null.
async function generateElementCutout(origBase64, mimeType, element, canvasW, canvasH) {
  try {
    const [ymin, xmin, ymax, xmax] = element.bbox;

    const { base64: keyedB64 } = await generateReanimImage([
      { inlineData: { mimeType, data: origBase64 } },
      { text: REANIM_CUTOUT_PROMPT(element.label) },
    ]);

    const keyedPng = await chromaKeyMagenta(Buffer.from(keyedB64, "base64"));

    // Resize back to canvas geometry (Gemini may change output resolution),
    // then extract the bbox region so alignment matches the original exactly.
    const aligned = await sharp(keyedPng)
      .resize(canvasW, canvasH, { fit: "fill" })
      .png()
      .toBuffer();

    const left = Math.round((xmin / 1000) * canvasW);
    const top = Math.round((ymin / 1000) * canvasH);
    const width = Math.max(4, Math.min(canvasW - left, Math.round(((xmax - xmin) / 1000) * canvasW)));
    const height = Math.max(4, Math.min(canvasH - top, Math.round(((ymax - ymin) / 1000) * canvasH)));

    const cropped = await sharp(aligned)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();

    // Reject failed generations: if >92% of pixels are transparent the cutout is empty
    const stats = await sharp(cropped).stats();
    const alphaChannelIndex = stats.channels.length - 1;
    const alphaMean = stats.channels[alphaChannelIndex]?.mean ?? 255;
    if (alphaMean < 20) {
      console.warn(`⚠️ Reanimate cutout for "${element.label}" is empty — dropping element`);
      return null;
    }

    return { buffer: cropped, left, top, width, height };
  } catch (err) {
    console.error(`⚠️ Reanimate cutout failed for "${element.label}":`, err.message);
    return null;
  }
}

// ── Easing / motion math ──────────────────────────────────────────────────────

const easeOutBack = (u) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
};

// Per-effect transform at time t (seconds). Returns {dx, dy, scaleDeg...}
function getElementTransform(element, t, canvasW, canvasH) {
  const clampedT = Math.min(t, REANIM_ENTRANCE_S);
  const u = clampedT / REANIM_ENTRANCE_S;

  switch (element.effect) {
    case "bounce": {
      // Drop from above into place with one damped overshoot below
      const A = canvasH * 0.10;
      const dy = -A * Math.exp(-4 * u) * Math.cos(10 * u);
      return { dx: 0, dy, scale: 1, rotateDeg: 0 };
    }
    case "slide_right": {
      const s = Math.min(clampedT / REANIM_SLIDE_T1_S, 1);
      const eased = easeOutBack(s); // slight overshoot past target, settles back
      const dx = (1 - eased) * (canvasW - element.rect.left);
      return { dx, dy: 0, scale: 1, rotateDeg: 0 };
    }
    case "wiggle": {
      const rotateDeg = 4 * Math.exp(-3 * u) * Math.sin(14 * u);
      return { dx: 0, dy: 0, scale: 1, rotateDeg };
    }
    case "scale_bounce": {
      const scale = 1 + 0.45 * Math.exp(-4 * u) * (-Math.cos(10 * u));
      return { dx: 0, dy: 0, scale, rotateDeg: 0 };
    }
    default:
      return { dx: 0, dy: 0, scale: 1, rotateDeg: 0 };
  }
}

function transformIsResting(transform) {
  return (
    Math.abs(transform.dx) < 0.5 &&
    Math.abs(transform.dy) < 0.5 &&
    Math.abs(transform.rotateDeg) < 0.05 &&
    Math.abs(transform.scale - 1) < 0.002
  );
}

// Render a transformed layer buffer (scaled/rotated cutout) anchored to center
async function renderLayerBuffer(cutout, transform) {
  const scaledW = Math.max(2, Math.round(cutout.width * transform.scale));
  const scaledH = Math.max(2, Math.round(cutout.height * transform.scale));

  let pipe = sharp(cutout.buffer).resize(scaledW, scaledH, { fit: "fill" });
  if (Math.abs(transform.rotateDeg) > 0.05) {
    pipe = pipe.rotate(transform.rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  return pipe.png().toBuffer();
}

// ── Frame renderer + FFmpeg encoder ───────────────────────────────────────────

function resolveFfmpegPath() {
  try {
    const ffmpegStatic = require("ffmpeg-static");
    if (ffmpegStatic) return ffmpegStatic;
  } catch { /* fall through to system binary */ }
  return "ffmpeg";
}

async function renderReanimationVideo(baseImageBuffer, layers, canvasW, canvasH) {
  const { spawn } = require("child_process");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  const outputPath = path.join(os.tmpdir(), `reanim_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const ffmpegPath = resolveFfmpegPath();

  const ffmpegArgs = [
    "-y",
    // image2pipe: each frame arrives as a fully-encoded PNG (self-describing
    // dimensions/format) — eliminates any raw-RGB stride mismatch that can
    // produce static-like corruption.
    "-f", "image2pipe",
    "-framerate", String(REANIM_FPS),
    "-i", "-",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ffmpegArgs);
    let stderr = "";

    proc.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    proc.on("error", reject);
    // Prevent unhandled EPIPE if ffmpeg dies while we are mid-write
    if (proc.stdin) proc.stdin.on("error", () => {});
    proc.on("close", (code) => {
      if (code === 0) {
        fs.readFile(outputPath, (readErr, mp4Buffer) => {
          fs.unlink(outputPath, () => {});
          if (readErr) reject(readErr); else resolve(mp4Buffer);
        });
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
      }
    });

    // Push one layer into the frame's composite list, clipping it to the canvas.
    // sharp composite offsets must stay in-bounds, so off-screen portions are
    // cropped from the layer buffer first (needed for slide_from_right start).
    const pushComposite = async (composites, buf, meta, left, top) => {
      const cw = canvasW;
      const chh = canvasH;
      if (left >= cw || top >= chh || left + meta.width <= 0 || top + meta.height <= 0) return;

      let inBuf = buf;
      let inLeft = left;
      let inTop = top;

      if (inLeft < 0 || inTop < 0 || inLeft + meta.width > cw || inTop + meta.height > chh) {
        const cropLeft = Math.max(0, -inLeft);
        const cropTop = Math.max(0, -inTop);
        const newLeft = Math.max(0, inLeft);
        const newTop = Math.max(0, inTop);
        const cropW = Math.min(meta.width - cropLeft, cw - newLeft);
        const cropH = Math.min(meta.height - cropTop, chh - newTop);
        if (cropW < 2 || cropH < 2) return;
        inBuf = await sharp(buf)
          .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
          .png()
          .toBuffer();
        inLeft = newLeft;
        inTop = newTop;
      }

      composites.push({ input: inBuf, left: inLeft, top: inTop });
    };

    // Write frames asynchronously
    (async () => {
      try {
        const totalFrames = REANIM_DURATION_S * REANIM_FPS;
        // Cache resting buffers per layer so post-entrance frames are cheap
        const layerState = layers.map((layer) => ({
          ...layer,
          cachedBuf: null,
          cachedMeta: null,
          cachedSig: "",
          restingBuf: null,
          restingMeta: null,
        }));

        for (let f = 0; f < totalFrames; f += 1) {
          const t = f / REANIM_FPS;
          const composites = [];

          for (const state of layerState) {
            const transform = getElementTransform(state.element, t, canvasW, canvasH);
            const resting = transformIsResting(transform);
            const sig = `${transform.scale.toFixed(4)}_${transform.rotateDeg.toFixed(3)}`;

            let buf;
            if (resting) {
              // Identity transform — render/cache once
              if (!state.restingBuf) {
                state.restingBuf = await renderLayerBuffer(state.cutout, { dx: 0, dy: 0, scale: 1, rotateDeg: 0 });
                state.restingMeta = await sharp(state.restingBuf).metadata();
              }
              buf = state.restingBuf;
            } else {
              if (sig !== state.cachedSig) {
                state.cachedBuf = await renderLayerBuffer(state.cutout, transform);
                state.cachedMeta = await sharp(state.cachedBuf).metadata();
                state.cachedSig = sig;
              }
              buf = state.cachedBuf;
            }
            if (!buf) continue;

            const meta = resting ? state.restingMeta : state.cachedMeta;

            // Anchor transformed buffer to the cutout's center point
            const centerX = state.cutout.left + state.cutout.width / 2 + transform.dx;
            const centerY = state.cutout.top + state.cutout.height / 2 + transform.dy;
            await pushComposite(
              composites,
              buf,
              meta,
              Math.round(centerX - meta.width / 2),
              Math.round(centerY - meta.height / 2),
            );
          }

          const frameRaw = await sharp(baseImageBuffer)
            .composite(composites)
            .flatten({ background: "#000000" })
            // compressionLevel 0 = store-only PNG: fast to encode, decoded
            // losslessly by ffmpeg from the image2pipe stream
            .png({ compressionLevel: 0 })
            .toBuffer();

          if (!proc.stdin.write(frameRaw)) {
            await new Promise((resolve) => proc.stdin.once("drain", resolve));
          }
        }

        proc.stdin.end();
      } catch (err) {
        proc.kill("SIGKILL");
        reject(err);
      }
    })();
  });
}

// ── Cloudinary video upload helper ────────────────────────────────────────────

async function uploadReanimationToCloudinary(mp4Buffer, publicIdPrefix) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tempPath = path.join(os.tmpdir(), `reanim_upload_${Date.now()}.mp4`);

  fs.writeFileSync(tempPath, mp4Buffer);
  try {
    const result = await cloudinary.uploader.upload(tempPath, {
      folder: "reanimations",
      public_id: `${publicIdPrefix}_reanimate_${Date.now()}`,
      resource_type: "video",
    });
    return { videoUrl: result.secure_url, publicId: result.public_id, width: result.width, height: result.height };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// ── Full pipeline (runs async after POST responds 202) ────────────────────────

const reanimRunningSet = new Set(); // uploadIds with a job in flight

async function runReanimationJob(uploadId, options = {}) {
  const { ratioKey = REANIM_CACHE_KEY, targetWidth = null, targetHeight = null } = options;
  const startedAt = Date.now();
  reanimRunningSet.add(uploadId);

  try {
    const upload = await Upload.findById(uploadId);
    if (!upload) return;

    console.log(`\n🎬 REANIMATE START — upload ${uploadId} (ratio: ${ratioKey})`);

    // ── STEP 0 — Source selection: original vs refit ────────────────────────
    // If the upload doesn't match the billboard's target aspect ratio, animate
    // the refit version instead. Reuse the cached refit if present; otherwise
    // generate one via the existing refit pipeline and persist it in
    // upload.refits so it is documented and never regenerated.
    let sourceUrl = upload.cloudinaryUrl;
    let sourceKind = "original";

    const tw = parseInt(targetWidth);
    const th = parseInt(targetHeight);
    const hasTarget = Number.isFinite(tw) && Number.isFinite(th) && tw > 0 && th > 0;

    if (
      hasTarget &&
      upload.dimensions?.width &&
      upload.dimensions?.height
    ) {
      const srcAR = upload.dimensions.width / upload.dimensions.height;
      const tgtAR = tw / th;
      const mismatched = Math.abs(srcAR - tgtAR) > 0.05 * tgtAR;

      if (mismatched) {
        const existingRefit = upload.refits?.get(ratioKey);
        if (existingRefit?.cloudinaryUrl) {
          sourceUrl = existingRefit.cloudinaryUrl;
          sourceKind = "refit";
          console.log(`📐 Aspect mismatch — using cached refit for ${ratioKey}`);
        } else {
          console.log(`📐 Aspect mismatch — generating refit for ${ratioKey} first`);
          const refitResult = await generateRefitWithGemini(upload.cloudinaryUrl, tw, th);
          const cloudRefit = await uploadRefitToCloudinary(
            refitResult.imageBase64,
            refitResult.mimeType,
            upload.publicId
          );
          upload.markModified("refits");
          upload.refits.set(ratioKey, {
            cloudinaryUrl: cloudRefit.cloudinaryUrl,
            publicId: cloudRefit.publicId,
            dimensions: cloudRefit.dimensions,
            createdAt: new Date()
          });
          await upload.save();
          sourceUrl = cloudRefit.cloudinaryUrl;
          sourceKind = "refit";
          console.log(`✅ Refit generated and cached under ${ratioKey}`);
        }
      }
    }

    // ── Canvas geometry from the ACTUAL source image ─────────────────────────
    const sourceBuffer = await fetchImageAsBuffer(sourceUrl);
    const sourceMeta = await sharp(sourceBuffer).metadata();
    const mimeType = sourceMeta.format === "png" ? "image/png" : "image/jpeg";
    const sourceBase64 = sourceBuffer.toString("base64");

    const srcW = sourceMeta.width || upload.dimensions?.width || 1080;
    const srcH = sourceMeta.height || upload.dimensions?.height || 1080;
    const scaleDown = Math.min(1, REANIM_MAX_SIDE / Math.max(srcW, srcH));
    const canvasW = Math.max(2, Math.round((srcW * scaleDown) / 2) * 2);
    const canvasH = Math.max(2, Math.round((srcH * scaleDown) / 2) * 2);

    // STEP 1 — Detect elements
    const elements = await detectReanimateElements(sourceBase64, mimeType);
    if (elements.length === 0) throw new Error("No animatable elements detected");
    console.log(`🎯 Detected ${elements.length} elements:`, elements.map((e) => `${e.label}→${e.effect}`).join(", "));

    // Attach pixel rects used by motion math
    for (const el of elements) {
      const [ymin, xmin, ymax, xmax] = el.bbox;
      el.rect = {
        left: Math.round((xmin / 1000) * canvasW),
        top: Math.round((ymin / 1000) * canvasH),
        width: Math.max(4, Math.round(((xmax - xmin) / 1000) * canvasW)),
        height: Math.max(4, Math.round(((ymax - ymin) / 1000) * canvasH)),
      };
    }

    // STEP 2 — Clean plate (fallback: original image if edit fails)
    let baseImageBuffer = sourceBuffer;
    try {
      const cleanPlate = await generateReanimImage([
        { inlineData: { mimeType, data: sourceBase64 } },
        { text: REANIM_CLEAN_PLATE_PROMPT(elements.map((e) => e.label)) },
      ]);
      baseImageBuffer = await sharp(Buffer.from(cleanPlate.base64, "base64"))
        .resize(canvasW, canvasH, { fit: "fill" })
        .jpeg({ quality: 92 })
        .toBuffer();
      console.log("🧽 Clean plate ready");
    } catch (err) {
      console.warn("⚠️ Clean plate generation failed — using original as base:", err.message);
      baseImageBuffer = await sharp(sourceBuffer)
        .resize(canvasW, canvasH, { fit: "fill" })
        .flatten({ background: "#000000" })
        .jpeg({ quality: 92 })
        .toBuffer();
    }

    // STEP 3 — Cutouts (sequential — respects the shared Gemini image quota)
    const cutouts = [];
    for (const el of elements) {
      const cutout = await generateElementCutout(sourceBase64, mimeType, el, canvasW, canvasH);
      if (cutout) cutouts.push({ element: el, cutout });
    }

    if (cutouts.length === 0) throw new Error("All element cutouts failed");
    console.log(`✂️  ${cutouts.length}/${elements.length} cutouts ready`);

    // STEP 4 — Render MP4
    const mp4Buffer = await renderReanimationVideo(
      baseImageBuffer,
      cutouts,
      canvasW,
      canvasH,
    );
    console.log(`🎥 Rendered ${(mp4Buffer.length / 1024 / 1024).toFixed(2)}MB MP4 in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    // STEP 5 — Upload + persist
    const cloudResult = await uploadReanimationToCloudinary(mp4Buffer, upload.publicId);

    upload.markModified("reanimations");
    upload.reanimations.set(ratioKey, {
      status: "completed",
      videoUrl: cloudResult.videoUrl,
      publicId: cloudResult.publicId,
      durationSec: REANIM_DURATION_S,
      width: cloudResult.width,
      height: cloudResult.height,
      elements: cutouts.map((c) => ({ label: c.element.label, type: c.element.type, effect: c.element.effect })),
      aspectRatio: ratioKey === REANIM_CACHE_KEY ? null : ratioKey,
      source: sourceKind,
      createdAt: new Date(),
    });
    await upload.save();

    io.to("reviewers").emit("reanimate-complete", { uploadId, reanimation: upload.reanimations.get(ratioKey) });
    console.log(`✅ REANIMATE DONE — upload ${uploadId} → ${cloudResult.videoUrl}`);
  } catch (err) {
    console.error(`❌ REANIMATE FAILED — upload ${uploadId}:`, err.message);
    try {
      const upload = await Upload.findById(uploadId);
      if (upload) {
        upload.markModified("reanimations");
        upload.reanimations.set(ratioKey, {
          status: "failed",
          error: err.message.slice(0, 300),
          aspectRatio: ratioKey === REANIM_CACHE_KEY ? null : ratioKey,
          createdAt: new Date(),
        });
        await upload.save();
      }
    } catch { /* ignore secondary failure */ }
  } finally {
    reanimRunningSet.delete(uploadId);
  }
}

// ── Reanimate endpoints ───────────────────────────────────────────────────────

// POST /api/uploads/:id/reanimate
// Body (optional): { targetWidth, targetHeight } — the billboard's pixel dims.
//   When provided and the upload doesn't match that aspect ratio, the refit
//   version is used as the animation source (generated + cached if missing),
//   and the result is cached under that aspect-ratio key so it is never
//   regenerated for the same placement.
app.post('/api/uploads/:id/reanimate', auth, async (req, res) => {
  try {
    const upload = await Upload.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!upload) return res.status(404).json({ error: 'Upload not found' });

    if (upload.resourceType === 'video') {
      return res.status(400).json({ error: 'Reanimate currently supports images only' });
    }

    const tw = parseInt(req.body?.targetWidth);
    const th = parseInt(req.body?.targetHeight);
    const hasTarget = Number.isFinite(tw) && Number.isFinite(th) && tw > 0 && th > 0;
    const ratioKey = hasTarget ? simplifyAspectRatio(tw, th) : REANIM_CACHE_KEY;

    const existing = upload.reanimations?.get(ratioKey);
    if (existing?.status === 'completed' && existing.videoUrl) {
      return res.json({ success: true, cached: true, status: 'completed', key: ratioKey, reanimation: existing });
    }

    if (reanimRunningSet.has(upload._id.toString())) {
      return res.status(202).json({ success: true, cached: false, status: 'processing', key: ratioKey });
    }

    upload.markModified("reanimations");
    upload.reanimations.set(ratioKey, {
      status: 'processing',
      aspectRatio: hasTarget ? ratioKey : null,
      createdAt: new Date()
    });
    await upload.save();

    // Fire-and-forget — client polls GET /api/uploads/:id for completion
    runReanimationJob(upload._id.toString(), hasTarget ? { ratioKey, targetWidth: tw, targetHeight: th } : {});

    res.status(202).json({ success: true, cached: false, status: 'processing', key: ratioKey });
  } catch (err) {
    console.error('Reanimate request error:', err);
    res.status(500).json({ error: err.message });
  }
});



const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = { app, server, io };
