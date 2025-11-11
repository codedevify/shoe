// routes/store.js
const stripeLib = require('stripe');
const nodemailer = require('nodemailer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Config = require('../models/Config');

module.exports = function (getEmailConfig, app) {
  const router = require('express').Router();
  let transporter;

  async function createTransporter() {
    const cfg = await getEmailConfig();
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.emailUser, pass: cfg.emailPass },
    });
    console.log('Transporter refreshed with:', cfg.emailUser);
  }
  createTransporter();
  router.createTransporter = createTransporter;

  // HOME PAGE
  router.get('/', async (req, res) => {
    const products = await Product.find();
    res.render('index', { products, cart: req.session.cart || [] });
  });

  // ADD TO CART
  router.post('/add-to-cart/:id', async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/');

    if (!req.session.cart) req.session.cart = [];
    const existing = req.session.cart.find((i) => i.id === req.params.id);
    if (existing) {
      existing.quantity += 1;
    } else {
      req.session.cart.push({
        id: product._id,
        name: product.name,
        price: product.price,
        quantity: 1,
      });
    }

    // FORCE SESSION SAVE
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/');
    });
  });

  // CART PAGE
  router.get('/cart', (req, res) => {
    const cart = req.session.cart || [];
    const total = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    res.render('cart', { cart, total });
  });

  // CHECKOUT
  router.post('/checkout', async (req, res) => {
    const cfg = await getEmailConfig();
    const config = await Config.findOne();
    if (!config?.stripeSecretKey) return res.status(500).send('Stripe not set');

    const stripe = stripeLib(config.stripeSecretKey);
    const cart = req.session.cart || [];
    if (!cart.length) return res.redirect('/cart');

    const totalCents = cart.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100;

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: cart.map((i) => ({
          price_data: {
            currency: 'gbp',
            product_data: { name: i.name },
            unit_amount: Math.round(i.price * 100),
          },
          quantity: i.quantity,
        })),
        mode: 'payment',
        success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.protocol}://${req.get('host')}/cart`,
      });

      const order = new Order({
        items: cart.map((i) => ({ product: i.id, quantity: i.quantity })),
        total: totalCents / 100,
        email: req.body.email,
        stripeSessionId: session.id,
      });
      await order.save();

      await createTransporter();
      await transporter.sendMail({
        from: cfg.emailUser,
        to: req.body.email,
        subject: 'Order Received',
        html: `<h3>Order #${order._id}</h3><p>Total: £${order.total.toFixed(2)}</p>`,
      });

      res.redirect(303, session.url);
    } catch (err) {
      res.status(500).send('Payment failed');
    }
  });

  // SUCCESS PAGE
  router.get('/success', async (req, res) => {
    req.session.cart = [];
    req.session.save();
    res.render('success', { message: 'Payment successful!' });
  });

  return router;
};
