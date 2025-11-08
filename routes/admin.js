// routes/admin.js
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const Product = require('../models/Product');
const Order = require('../models/Order');
const Config = require('../models/Config');
const Admin = require('../models/Admin');
const EmailConfig = require('../models/EmailConfig');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

module.exports = function(getEmailConfig, app) {
  const router = require('express').Router();

  const storage = multer.memoryStorage(); // Use memory for Cloudinary
  const upload = multer({ storage });

  const isAdmin = (req, res, next) => {
    if (req.session.admin) return next();
    res.redirect('/admin/login');
  };

  // Login
  router.get('/login', (req, res) => res.render('admin/login'));
  router.post('/login', async (req, res) => {
    const admin = await Admin.findOne({ username: req.body.username, password: req.body.password });
    if (admin) {
      req.session.admin = true;
      res.redirect('/admin');
    } else {
      res.send('Invalid login');
    }
  });

  // Dashboard
  router.get('/', isAdmin, async (req, res) => {
    const [orders, products, config, emailConfig] = await Promise.all([
      Order.find().populate('items.product'),
      Product.find(),
      Config.findOne(),
      EmailConfig.findOne()
    ]);
    res.render('admin/dashboard', { orders, products, config, emailConfig });
  });

  // Email Settings
  router.get('/email-settings', isAdmin, async (req, res) => {
    const emailConfig = await EmailConfig.findOne();
    res.render('admin/email-settings', { config: emailConfig });
  });

  router.post('/email-config', isAdmin, async (req, res) => {
    const { emailUser, emailPass, sellerEmail } = req.body;
    await EmailConfig.updateOne(
      {},
      { emailUser, emailPass, sellerEmail },
      { upsert: true }
    );

    // Refresh transporter
    const storeRoutes = require('./store');
    const storeRouter = storeRoutes(getEmailConfig, app);
    if (storeRouter.createTransporter) {
      storeRouter.createTransporter();
    }

    res.redirect('/admin/email-settings');
  });

  // Add Product (Cloudinary Upload)
  router.post('/product/add', isAdmin, upload.single('image'), async (req, res) => {
    let imageUrl = '';
    if (req.file) {
      const result = await cloudinary.uploader.upload_stream(
        { resource_type: 'auto' },
        (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
          } else {
            imageUrl = result.secure_url;
          }
        }
      ).end(req.file.buffer);
    }

    const product = new Product({
      name: req.body.name,
      description: req.body.desc,
      price: req.body.price,
      image: imageUrl || req.body.existingImage // Fallback for no file
    });
    await product.save();
    res.redirect('/admin');
  });

  // Edit Product (Cloudinary Upload)
  router.post('/product/edit/:id', isAdmin, upload.single('image'), async (req, res) => {
    const product = await Product.findById(req.params.id);
    const update = {
      name: req.body.name,
      description: req.body.desc,
      price: req.body.price
    };

    if (req.file) {
      // Delete old image from Cloudinary if exists
      if (product.image.startsWith('https://res.cloudinary.com/')) {
        const publicId = product.image.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(publicId);
      }

      // Upload new
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'auto' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(req.file.buffer);
      });
      update.image = result.secure_url;
    }

    await Product.findByIdAndUpdate(req.params.id, update);
    res.redirect('/admin');
  });

  // Confirm Order
  router.post('/order/confirm/:id', isAdmin, async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { status: 'Confirmed' });
    res.redirect('/admin');
  });

  // Cancel Order
  router.post('/order/cancel/:id', isAdmin, async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { status: 'Cancelled' });
    res.redirect('/admin');
  });

  // Update Stripe Keys
  router.post('/config', isAdmin, async (req, res) => {
    await Config.updateOne(
      {},
      {
        stripePublishableKey: req.body.pk,
        stripeSecretKey: req.body.sk
      }
    );
    res.redirect('/admin');
  });

  return router;
};
