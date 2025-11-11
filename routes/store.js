// routes/store.js — FINAL UK LIVE VERSION
const stripeLib = require('stripe');
const nodemailer = require('nodemailer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Config = require('../models/Config');

module.exports = function(getEmailConfig, app) {
  const router = require('express').Router();
  let transporter;

  async function createTransporter() {
    const cfg = await getEmailConfig();
    if (!cfg?.emailUser || !cfg?.emailPass) return console.error('EMAIL CONFIG MISSING');
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.emailUser, pass: cfg.emailPass }
    });
    console.log('Transporter refreshed with:', cfg.emailUser);
  }

  createTransporter();
  router.createTransporter = createTransporter;

  // Home
  router.get('/', async (req, res) => {
    const products = await Product.find();
    res.render('index', { products, cart: req.session.cart || [] });
  });

  // AJAX: Add to Cart (NO REFRESH)
  router.post('/add-to-cart/:id', async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Not found' });

    if (!req.session.cart) req.session.cart = [];
    const existing = req.session.cart.find(i => i.id === req.params.id);
    if (existing) existing.quantity += 1;
    else req.session.cart.push({ id: product._id, name: product.name, price: product.price, quantity: 1 });

    const totalItems = req.session.cart.reduce((s, i) => s + i.quantity, 0);
    res.json({ success: true, totalItems });
  });

  // Cart Page
  router.get('/cart', (req, res) => {
    const cart = req.session.cart || [];
    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    res.render('cart', { cart, total });
  });

  // Update Quantity
  router.post('/update-cart/:id', (req, res) => {
    const qty = parseInt(req.body.quantity);
    if (!req.session.cart || qty < 1) return res.status(400).json({ error: 'Invalid' });
    const item = req.session.cart.find(i => i.id === req.params.id);
    if (item) item.quantity = qty;
    res.json({ success: true });
  });

  // Remove Item
  router.post('/remove-from-cart/:id', (req, res) => {
    if (req.session.cart) {
      req.session.cart = req.session.cart.filter(i => i.id !== req.params.id);
    }
    res.json({ success: true });
  });

  // Checkout
  router.post('/checkout', async (req, res) => {
    const cfg = await getEmailConfig();
    const config = await Config.findOne();
    if (!config?.stripeSecretKey) return res.status(500).send('Stripe not configured');

    const stripe = stripeLib(config.stripeSecretKey);
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.redirect('/cart');

    const totalCents = cart.reduce((s, i) => s + i.price * i.quantity, 0) * 100;

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: cart.map(i => ({
          price_data: {
            currency: 'gbp',
            product_data: { name: i.name },
            unit_amount: Math.round(i.price * 100)
          },
          quantity: i.quantity
        })),
        mode: 'payment',
        success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.protocol}://${req.get('host')}/cart`
      });

      const order = new Order({
        items: cart.map(i => ({ product: i.id, quantity: i.quantity })),
        total: totalCents / 100,
        email: req.body.email,
        stripeSessionId: session.id
      });
      await order.save();

      await createTransporter();

      await transporter.sendMail({
        from: cfg.emailUser,
        to: req.body.email,
        subject: 'Order Received - Urban Solz',
        html: `<h3>Order #${order._id}</h3><p>Total: £${order.total.toFixed(2)}</p><p><a href="${req.protocol}://${req.get('host')}/order/confirm/${order._id}">Confirm</a> | <a href="${req.protocol}://${req.get('host')}/order/cancel/${order._id}">Cancel</a></p>`
      });

      await transporter.sendMail({
        from: cfg.emailUser,
        to: cfg.sellerEmail,
        subject: `New Order #${order._id}`,
        text: `£${order.total.toFixed(2)} from ${req.body.email}`
      });

      res.redirect(303, session.url);
    } catch (err) {
      console.error('Checkout error:', err);
      res.status(500).send('Payment failed');
    }
  });

  // Success
  router.get('/success', async (req, res) => {
    const config = await Config.findOne();
    if (!config?.stripeSecretKey || !req.query.session_id) {
      return res.render('success', { message: 'Payment processed.' });
    }
    const stripe = stripeLib(config.stripeSecretKey);
    try {
      const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
      if (session.payment_status === 'paid') {
        req.session.cart = [];
        res.render('success', { message: 'Payment successful!' });
      } else {
        res.render('success', { message: 'Payment pending.' });
      }
    } catch {
      res.render('success', { message: 'Payment processed.' });
    }
  });

  // Confirm / Cancel
  router.get('/order/confirm/:id', async (req, res) => { /* same */ });
  router.get('/order/cancel/:id', async (req, res) => { /* same */ });

  return router;
};
