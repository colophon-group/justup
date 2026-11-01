// Pure Stripe test-mode billing projections. These functions grant no access,
// read no credentials and perform no network or persistence operations.
const DAY = 86_400_000;
const fail = (code = 'billing_evidence_invalid', status = 400) => {
  throw Object.assign(new Error('Billing evidence could not be verified.'), {code, status});
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{1,128}$`).test(value);
const ref = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const objectId = value => typeof value === 'string' ? value : plain(value) ? value.id : null;
const timestamp = value => Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value * 1000);
function testObject(value, object, identifier, prefix) {
  if (!plain(value) || value.object !== object || value.livemode !== false
      || !id(value.id, prefix) || value.id !== identifier) fail();
}
function oneItem(value) {
  if (!plain(value) || value.object !== 'list' || value.has_more !== false
      || !Array.isArray(value.data) || value.data.length !== 1) fail();
  return value.data[0];
}
function priceIds(prices) {
  if (!plain(prices) || Object.keys(prices).sort().join(',') !== 'monthly,weekly'
      || !id(prices.weekly, 'price') || !id(prices.monthly, 'price')
      || prices.weekly === prices.monthly) fail('billing_unavailable', 503);
  return prices;
}

export function stripeOffer(price, {plan, prices} = {}) {
  priceIds(prices);
  if (!['weekly', 'monthly'].includes(plan)) fail();
  testObject(price, 'price', prices[plan], 'price');
  if (price.active !== true || price.type !== 'recurring' || price.billing_scheme !== 'per_unit'
      || !Number.isSafeInteger(price.unit_amount) || price.unit_amount < 1 || price.unit_amount > 1_000_000_000
      || !/^[a-z]{3}$/.test(price.currency ?? '') || price.custom_unit_amount != null
      || price.transform_quantity != null || !plain(price.recurring)
      || price.recurring.interval !== (plan === 'weekly' ? 'week' : 'month')
      || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed'
      || price.recurring.trial_period_days != null) fail();
  return {plan, currency:price.currency, amount:price.unit_amount, interval:price.recurring.interval};
}

// This selects a reference from an already signature-verified snapshot event.
// It deliberately ignores event time, metadata claims and all account ownership.
export function stripeEventReference(event, {accountId} = {}) {
  if (!plain(event) || event.object !== 'event' || event.livemode !== false || !id(event.id, 'evt')
      || !id(accountId, 'acct') || event.account != null && event.account !== accountId
      || event.context != null || typeof event.type !== 'string' || event.type.length > 128) fail();
  const shapes = {
    'customer.subscription.created':['subscription','subscription','sub'],
    'customer.subscription.updated':['subscription','subscription','sub'],
    'customer.subscription.deleted':['subscription','subscription','sub'],
    'invoice.paid':['invoice','invoice','in'],
    'invoice.payment_succeeded':['invoice','invoice','in'],
    'invoice.payment_failed':['invoice','invoice','in'],
    'invoice.voided':['invoice','invoice','in'],
    'invoice.marked_uncollectible':['invoice','invoice','in'],
    'checkout.session.completed':['checkout','checkout.session','cs_test'],
    'checkout.session.async_payment_succeeded':['checkout','checkout.session','cs_test'],
    'checkout.session.async_payment_failed':['checkout','checkout.session','cs_test'],
    'checkout.session.expired':['checkout','checkout.session','cs_test'],
    'charge.refunded':['charge','charge','ch'],
    'charge.dispute.created':['dispute','dispute','dp'],
    'charge.dispute.closed':['dispute','dispute','dp'],
  };
  const shape = Object.hasOwn(shapes,event.type) ? shapes[event.type] : null;
  if (!shape) return null;
  const value = event.data?.object;
  if (!plain(value) || !id(value.id, shape[2]) || value.object !== shape[1]
      || value.livemode !== false) fail();
  if (shape[0] === 'dispute') {
    const chargeId = objectId(value.charge);
    if (!id(chargeId, 'ch')) fail();
    return {eventId:event.id, kind:'charge', resourceId:chargeId, customerId:null};
  }
  const customerId = objectId(value.customer);
  if (!id(customerId,'cus')) fail();
  return {eventId:event.id, kind:shape[0], resourceId:value.id, customerId};
}

export function stripeHostedUrl(kind, value) {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]|\\/.test(value)) fail();
  let url;
  try {url = new URL(value);} catch {fail();}
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href !== value) fail();
  if (kind === 'checkout') {
    if (url.hostname !== 'checkout.stripe.com' || !/^\/c\/pay\/cs_test_[A-Za-z0-9]+$/.test(url.pathname)
        || url.search) fail();
  } else if (kind === 'portal') {
    if (url.hostname !== 'billing.stripe.com' || url.hash) fail();
    if (/^\/p\/session\/test_[A-Za-z0-9]+$/.test(url.pathname)) {
      if (url.search) fail();
    } else if (url.pathname === '/p/session') {
      if ([...url.searchParams.keys()].join(',') !== 'secret'
          || !/^test_[A-Za-z0-9_-]+$/.test(url.searchParams.get('secret') ?? '')) fail();
    } else fail();
  } else fail();
  return value;
}

function returnUrl(value) {
  if (typeof value !== 'string') fail();
  let url;
  try {url = new URL(value);} catch {fail();}
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
      || url.search || url.hash || url.href !== value) fail();
  return url.href;
}

export function stripeCheckoutFields({plan, prices, customerId, billingReference, returnTo, expiresAt, now = Date.now()} = {}) {
  priceIds(prices);
  if (!['weekly','monthly'].includes(plan) || !id(customerId,'cus') || !ref(billingReference)
      || !Number.isSafeInteger(now) || !timestamp(expiresAt)
      || expiresAt * 1000 < now + 30 * 60_000 || expiresAt * 1000 > now + 31 * 60_000) fail();
  return {
    mode:'subscription', customer:customerId, client_reference_id:billingReference,
    'metadata[justup_reference]':billingReference,
    'subscription_data[metadata][justup_reference]':billingReference,
    'line_items[0][price]':prices[plan], 'line_items[0][quantity]':'1',
    'payment_method_types[0]':'card', allow_promotion_codes:'false',
    'automatic_tax[enabled]':'false', success_url:returnUrl(returnTo), cancel_url:returnUrl(returnTo),
    expires_at:String(expiresAt),
  };
}

export function stripePortalFields({customerId, configurationId, returnTo} = {}) {
  if (!id(customerId,'cus') || !id(configurationId,'bpc')) fail();
  return {customer:customerId, configuration:configurationId, return_url:returnUrl(returnTo)};
}

function subscriptionEvidence(subscription, binding, prices) {
  priceIds(prices);
  if (!plain(binding) || !id(binding.customerId,'cus') || !id(binding.subscriptionId,'sub')
      || !ref(binding.billingReference) || typeof binding.accountId !== 'string' || !binding.accountId) fail();
  testObject(subscription,'subscription',binding.subscriptionId,'sub');
  if (objectId(subscription.customer) !== binding.customerId
      || subscription.metadata?.justup_reference !== binding.billingReference
      || subscription.collection_method !== 'charge_automatically' || subscription.on_behalf_of != null
      || subscription.application != null || subscription.transfer_data != null
      || !['active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused','trialing'].includes(subscription.status)
      || typeof subscription.cancel_at_period_end !== 'boolean') fail();
  const item = oneItem(subscription.items);
  if (!plain(item) || item.object !== 'subscription_item' || !id(item.id,'si')
      || item.subscription !== binding.subscriptionId || item.quantity !== 1) fail();
  const plan = Object.keys(prices).find(key => prices[key] === item.price?.id);
  if (!plan) fail();
  const offer = stripeOffer(item.price,{plan,prices});
  if (!timestamp(item.current_period_start) || !timestamp(item.current_period_end)
      || item.current_period_start >= item.current_period_end) fail();
  return {item,plan,offer};
}

// Invoice aggregate dates do not define service. Exactly one non-prorated line,
// one successful on-Stripe payment and its current unrefunded charge must agree.
export function stripeSettledPeriod({subscription,invoice,paymentIntent,charge,binding,prices,now=Date.now()} = {}) {
  const {item,offer} = subscriptionEvidence(subscription,binding,prices);
  if (!Number.isSafeInteger(now) || now <= 0) fail();
  testObject(invoice,'invoice',invoice?.id,'in');
  if (objectId(invoice.customer) !== binding.customerId || invoice.status !== 'paid'
      || invoice.collection_method !== 'charge_automatically' || invoice.currency !== offer.currency
      || invoice.parent?.type !== 'subscription_details'
      || objectId(invoice.parent.subscription_details?.subscription) !== binding.subscriptionId
      || !['subscription_create','subscription_cycle'].includes(invoice.billing_reason)
      || invoice.amount_due !== offer.amount || invoice.amount_paid !== offer.amount
      || invoice.amount_remaining !== 0 || invoice.post_payment_credit_notes_amount !== 0
      || invoice.pre_payment_credit_notes_amount !== 0) fail();
  const line = oneItem(invoice.lines), parent = line?.parent?.subscription_item_details;
  if (!plain(line) || line.object !== 'line_item' || line.livemode !== false
      || line.parent?.type !== 'subscription_item_details' || parent?.proration !== false
      || parent.subscription_item !== item.id || objectId(parent.subscription) !== binding.subscriptionId
      || line.pricing?.type !== 'price_details' || line.pricing.price_details?.price !== item.price.id
      || line.quantity !== 1 || line.amount !== offer.amount || line.currency !== offer.currency
      || !timestamp(line.period?.start) || !timestamp(line.period?.end)
      || line.period.start >= line.period.end || line.period.start * 1000 > now
      || line.period.end > item.current_period_end
      || line.period.end * 1000 > now + 62 * DAY) fail();
  const payment = oneItem(invoice.payments);
  if (!plain(payment) || payment.object !== 'invoice_payment' || payment.livemode !== false
      || payment.status !== 'paid' || objectId(payment.invoice) !== invoice.id
      || payment.amount_paid !== offer.amount || payment.currency !== offer.currency
      || payment.payment?.type !== 'payment_intent' || !id(payment.payment.payment_intent,'pi')) fail();
  testObject(paymentIntent,'payment_intent',payment.payment.payment_intent,'pi');
  if (objectId(paymentIntent.customer) !== binding.customerId || paymentIntent.status !== 'succeeded'
      || paymentIntent.currency !== offer.currency || paymentIntent.amount_received !== offer.amount
      || paymentIntent.amount !== offer.amount || !id(objectId(paymentIntent.latest_charge),'ch')) fail();
  testObject(charge,'charge',objectId(paymentIntent.latest_charge),'ch');
  if (objectId(charge.customer) !== binding.customerId || objectId(charge.payment_intent) !== paymentIntent.id
      || charge.currency !== offer.currency || charge.amount !== offer.amount || charge.amount_captured !== offer.amount
      || charge.paid !== true || charge.captured !== true || charge.refunded !== false
      || charge.amount_refunded !== 0 || charge.disputed !== false || charge.status !== 'succeeded') fail();
  return {invoiceId:invoice.id,paidThroughAt:line.period.end * 1000};
}

export function stripeEntitlementSnapshot({subscription,settledPeriods=[],binding,prices,observedAt} = {}) {
  const {plan} = subscriptionEvidence(subscription,binding,prices);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || !Array.isArray(settledPeriods)
      || settledPeriods.length > 2) fail();
  const allowed = new Set([objectId(subscription.latest_invoice),binding.settledInvoiceId].filter(Boolean));
  for (const period of settledPeriods) {
    if (!plain(period) || !allowed.has(period.invoiceId) || !id(period.invoiceId,'in')
        || !Number.isSafeInteger(period.paidThroughAt) || period.paidThroughAt <= 0
        || period.paidThroughAt > observedAt + 62 * DAY) fail();
  }
  const paidThroughAt = settledPeriods.length ? Math.max(...settledPeriods.map(value => value.paidThroughAt)) : null;
  const canKeepPaidPeriod = ['active','past_due','canceled'].includes(subscription.status);
  const status = !canKeepPaidPeriod ? 'ended' : subscription.status === 'past_due' ? 'past_due'
    : subscription.status === 'canceled' || subscription.cancel_at_period_end ? 'cancelled' : 'active';
  return {accountId:binding.accountId,subscriptionId:binding.subscriptionId,observedAt,status,plan,
    paidThroughAt:status === 'ended' ? null : paidThroughAt};
}

// A caller must compare closure revision and session again in its final SQL
// transaction. This pure predicate is not an authorization or deletion receipt.
export function stripeTerminationReady({closingRevision,proof,binding,now=Date.now()} = {}) {
  const completeList = value => plain(value) && value.object === 'list' && value.has_more === false
    && Array.isArray(value.data) && value.data.length <= 32;
  if (!integer(closingRevision) || closingRevision < 1 || !plain(proof) || !plain(binding)
      || proof.closureRevision !== closingRevision || proof.unresolvedOperations !== 0
      || !integer(now) || !integer(proof.verifiedAt) || proof.verifiedAt > now || now-proof.verifiedAt > 30_000
      || !id(binding.customerId,'cus') || !ref(binding.billingReference)
      || !plain(proof.customer) || proof.customer.object !== 'customer' || proof.customer.livemode !== false
      || proof.customer.id !== binding.customerId || proof.customer.metadata?.justup_reference !== binding.billingReference
      || !completeList(proof.checkouts) || !completeList(proof.subscriptions)) return false;
  if (proof.checkouts.data.some(value => !plain(value) || value.object !== 'checkout.session'
      || value.livemode !== false || objectId(value.customer) !== binding.customerId
      || !id(value.id,'cs_test') || !['expired','complete'].includes(value.status))) return false;
  return proof.subscriptions.data.every(value => plain(value) && value.object === 'subscription'
    && value.livemode === false && objectId(value.customer) === binding.customerId
    && id(value.id,'sub') && value.status === 'canceled');
}
