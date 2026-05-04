

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
  } catch (err) {
    console.log("⚠️ Invalid/expired token");
  }
  next();
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

async function scaleToFitAspectRatio(srcBase64, targetWidth, targetHeight) {
  const inputBuffer = Buffer.from(srcBase64, 'base64');
  
  const outputBuffer = await sharp(inputBuffer)
    .resize(targetWidth, targetHeight, {
      fit: 'cover',        // fills canvas, no letterbox
      position: 'centre',
      kernel: sharp.kernel.lanczos3  // better quality than bilinear
    })
    .png({
      compressionLevel: 6,   // 0-9, 6 is good balance
      effort: 7,             // zopfli-style effort (1-10)
    })
    .toBuffer();

  return outputBuffer.toString('base64');
}

// ── Cloudinary upload helper ───────────────────────────────────────────────────

async function uploadRefitToCloudinary(imageBase64, mimeType, publicIdPrefix) {
  const { v4: uuidv4 } = require('uuid');
  const fs = require('fs');
  const tempPath = `uploads/refit_${uuidv4()}.png`;

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

  // ── STEP 2: Build request body ────────────────────────────────────────────
  let requestBody;

  if (ratioCheck.withinTolerance) {
    // Native path: use imageConfig with closest supported ratio + 4K quality
    const finalPrompt = `${NATIVE_PATH_SYSTEM_PROMPT}

Target output size: ${targetWidth}x${targetHeight}px (${ratioCheck.bestSupportedRatio}).
Fill the canvas edge-to-edge with no borders.`;

    requestBody = {
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

  } else {
    // Canvas path: send blank PNG reference to guide composition
    const referenceCanvas = getReferenceCanvasDimensions(targetWidth, targetHeight);
    const blankBase64 = generateBlankPngBase64(referenceCanvas.width, referenceCanvas.height);

    const finalPrompt = `${DEFAULT_SYSTEM_PROMPT}

Target output size: ${targetWidth}x${targetHeight}px.
The last image is a blank black reference canvas sized ${referenceCanvas.width}x${referenceCanvas.height}px. Use it as the exact composition guide and aspect ratio.`;

    requestBody = {
      contents: [{ role: "user", parts: [
        { inlineData: { mimeType, data: imageBase64 } },
        { inlineData: { mimeType: "image/png", data: blankBase64 } },
        { text: finalPrompt },
      ]}],
      generationConfig: {
        responseModalities: ["IMAGE"],
        // No imageConfig — canvas method only
      },
    };
  }

  // ── STEP 3: Call Gemini ───────────────────────────────────────────────────
  const projectId = "project-b275f288-bac3-429e-877";
  const region = "global";
  const model = "gemini-3-pro-image-preview";

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

  // ── STEP 4: Extract generated image ──────────────────────────────────────
  let generatedBase64 = null;
  let generatedMime = 'image/png';

  for (const part of result.candidates[0].content.parts) {
    if (part.inlineData) {
      generatedBase64 = part.inlineData.data;
      generatedMime = part.inlineData.mimeType || 'image/png';
      break;
    }
  }

  if (!generatedBase64) throw new Error('No image generated by Gemini');

  // ── STEP 5: PNG refix ─────────────────────────────────────────────────────
  // Exact native match → Gemini already output correct ratio, skip refix.
  // Approximated native (within 5%) → refix to exact target dims.
  // Canvas method (>5%) → refix to exact target dims.
  let finalBase64 = generatedBase64;
  const needsRefix = !ratioCheck.exactMatch;

  if (needsRefix) {
    const reason = !ratioCheck.withinTolerance ? 'canvas method' : 'approximated native ratio';
    console.log(`🖼  Running PNG refix (reason: ${reason})...`);

    if (generatedMime.includes('png')) {
      finalBase64 = await scaleToFitAspectRatio(generatedBase64, targetWidth, targetHeight);
      console.log('✅ PNG refix complete');
    } else {
      console.warn('⚠️  Non-PNG output from Gemini — skipping refix');
    }
  } else {
    console.log('✅ Exact native match — no refix needed');
  }

  return {
    imageBase64: finalBase64,
    mimeType: 'image/png',
    aspectRatio: simplifyAspectRatio(targetWidth, targetHeight),
    width: targetWidth,
    height: targetHeight,
    ratioPath: ratioCheck.withinTolerance ? 'native' : 'canvas',
    refixApplied: needsRefix,
  };
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

// ====================== START SERVER ======================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = { app, server, io };
