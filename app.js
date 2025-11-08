const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// --- TEST EMAIL (remove later) ---
const testEmailRoutes = require('./routes/test-email');
app.use('/', testEmailRoutes);

// --- MIDDLEWARE ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'shoe-store-secret',
  resave: false,
  saveUninitialized: true
}));
app.set('view engine', 'ejs');

// --- DATABASE ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('DB Error:', err));

// --- MODELS ---
const Product = require('./models/Product');
const Order = require('./models/Order');
const Config = require('./models/Config');
const Admin = require('./models/Admin');
const EmailConfig = require('./models/EmailConfig');

// --- GLOBAL EMAIL CONFIG ---
let getEmailConfig = () => ({ emailUser: 'fallback@gmail.com', emailPass: 'pass', sellerEmail: 'owner@example.com' });

async function loadEmailConfig() {
  let config = await EmailConfig.findOne();
  if (!config) {
    config = new EmailConfig({
      emailUser: process.env.EMAIL_USER || 'fallback@gmail.com',
      emailPass: process.env.EMAIL_PASS || 'fallback-pass',
      sellerEmail: process.env.SELLER_EMAIL || 'owner@example.com'
    });
    await config.save();
    console.log('Email config seeded from .env');
  }
  getEmailConfig = () => config;
  console.log('Email Config Loaded:', { from: config.emailUser, alerts: config.sellerEmail });
}
loadEmailConfig();

// --- PASS CONFIG TO ROUTES ---
const storeRoutes = require('./routes/store')(getEmailConfig, app);
const adminRoutes = require('./routes/admin')(getEmailConfig, app);

app.use('/', storeRoutes);
app.use('/admin', adminRoutes);

// --- SEED DATA ---
async function seedData() {
  try {
    if (await Admin.countDocuments() === 0) {
      await new Admin({ username: 'admin', password: 'password' }).save();
      console.log('Admin created: admin / password');
    }

    if (await Product.countDocuments() === 0) {
      const products = [
        { name: 'Nike Air Max', description: 'Comfortable running shoes', price: 120, image: 'https://via.placeholder.com/300x200?text=Nike+Air+Max' },
        { name: 'Adidas Ultraboost', description: 'High performance', price: 180, image: 'https://via.placeholder.com/300x200?text=Adidas+Ultraboost' },
        { name: 'Puma RS-X', description: 'Bold street style', price: 110, image: 'https://via.placeholder.com/300x200?text=Puma+RS-X' },
        { name: 'Reebok Classic', description: 'Timeless design', price: 80, image: 'https://via.placeholder.com/300x200?text=Reebok+Classic' },
        { name: 'Vans Old Skool', description: 'Skate culture icon', price: 70, image: 'https://via.placeholder.com/300x200?text=Vans+Old+Skool' },
        { name: 'Converse Chuck 70', description: 'Vintage high-top', price: 85, image: 'https://via.placeholder.com/300x200?text=Converse+Chuck+70' },
        { name: 'New Balance 550', description: 'Retro basketball', price: 130, image: 'https://via.placeholder.com/300x200?text=New+Balance+550' },
        { name: 'Jordan 1 Low', description: 'Iconic style', price: 150, image: 'https://via.placeholder.com/300x200?text=Jordan+1+Low' }
      ];
      await Product.insertMany(products);
      console.log('8 Products Seeded with placeholder images');
    }

    if (await Config.countDocuments() === 0) {
      await new Config({
        stripePublishableKey: 'pk_test_xxx',
        stripeSecretKey: 'sk_test_xxx'
      }).save();
      console.log('Stripe Config Seeded');
    }
  } catch (e) {
    console.error('Seed error:', e);
  }
}
seedData();

// --- SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
