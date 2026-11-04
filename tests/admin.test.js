import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { createMember, makeAdmin, PASSWORD } from './helpers/users.js';

const DAY = 86_400_000;
const flashOf = async (client, path = '/admin') => /class="flash flash-(?:success|error|info)"[^>]*>([^<]*)</.exec((await client.get(path)).text)?.[1];

describe('the admin console', () => {
  let app;
  let admin;
  let adminC;
  let modC;
  let mod;
  let memberC;
  let member;
  let creatorC;
  let creator;

  const video = (id, owner, title = `Video ${id}`) => app.ctx.db.query(`INSERT INTO videos (id, owner_id, title, status, visibility, published_at) VALUES ($1, $2, $3, 'ready', 'public', now())`, [id, owner, title]);
  const tipPaid = async (cents = 100_000) => {
    const payer = await app.ctx.db.one('SELECT * FROM users WHERE id = $1', [member.id]);
    const { paymentId } = await app.ctx.monetization.createTip({ payer, channelId: creator.id, amountMinor: cents });
    await app.ctx.monetization.applyProviderEvent({ id: `adm-${paymentId}`, rawType: 'test.paid', type: 'paid', providerRef: `test_${paymentId}`, amountMinor: cents, currency: 'INR', paidAt: null });
    return paymentId;
  };

  before(async () => {
    app = await startTestApp({ env: { PAYMENTS_PROVIDER: 'test' } });
    adminC = app.client();
    modC = app.client();
    memberC = app.client();
    creatorC = app.client();
    admin = await createMember(app, adminC, { email: 'root@example.com', handle: 'rootadmin', name: 'Root Admin' });
    mod = await createMember(app, modC, { email: 'mod@example.com', handle: 'moddy', name: 'Moddy' });
    member = await createMember(app, memberC, { email: 'mem@example.com', handle: 'member1', name: 'Member One' });
    creator = await createMember(app, creatorC, { email: 'cre@example.com', handle: 'creator1', name: 'Creator One' });
    await creatorC.post('/studio/terms', { agree: '1' });
    await makeAdmin(app, admin.id);
    await app.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
  });
  after(() => app.close());

  const MONEY = ['/admin/payouts', '/admin/payments', '/admin/revenue'];
  const ADMIN_ONLY = ['/admin/jobs', '/admin/audit'];
  const STAFF = ['/admin', '/admin/reports', '/admin/users', '/admin/videos', '/admin/messages'];

  describe('who can open what', () => {
    test('signed-out visitors are sent to sign in, and members see nothing exists', async () => {
      for (const p of [...STAFF, ...MONEY, ...ADMIN_ONLY]) {
        const out = await app.client().get(p);
        assert.equal(out.status, 303, p);
        assert.match(out.location, /^\/login\?next=/);
        assert.equal((await memberC.get(p)).status, 404, `${p} for a member`);
      }
    });

    test('moderators can use the moderation pages and nothing that touches money, jobs or the audit log', async () => {
      for (const p of STAFF) assert.equal((await modC.get(p)).status, 200, p);
      for (const p of [...MONEY, ...ADMIN_ONLY]) assert.equal((await modC.get(p)).status, 404, p);
      const nav = (await modC.get('/admin')).text;
      assert.ok(!nav.includes('/admin/payouts') && !nav.includes('/admin/audit'), 'the tabs do not even mention them');
    });

    test('administrators need two-step sign-in switched on before the money pages open', async () => {
      for (const p of MONEY) {
        const r = await adminC.get(p);
        assert.equal(r.status, 403, p);
        assert.match(r.text, /Turn on two-step verification/);
      }
      for (const p of [...STAFF, ...ADMIN_ONLY]) assert.equal((await adminC.get(p)).status, 200, p);
      await app.ctx.db.query('UPDATE users SET totp_enabled_at = now() WHERE id = $1', [admin.id]);
      for (const p of MONEY) assert.equal((await adminC.get(p)).status, 200, p);
    });

    test('every state-changing admin request needs the CSRF token, and members cannot make them at all', async () => {
      const posts = ['/admin/reports/1', `/admin/users/${member.id}/suspend`, `/admin/users/${member.id}/role`, '/admin/videos/AAAAAAAAAAA/remove', '/admin/messages/1/status', `/admin/payouts/${member.id}/approve`, `/admin/payments/${member.id}/refund`, '/admin/revenue', '/admin/jobs/1/retry'];
      for (const p of posts) {
        assert.equal((await adminC.post(p, { reason: 'x' }, { csrf: false })).status, 403, `${p} without a token`);
        assert.equal((await memberC.post(p, { reason: 'x' })).status, 404, `${p} as a member`);
      }
    });

    test('with payments switched off the money pages do not exist even for administrators', async () => {
      const off = await startTestApp({ env: { PAYMENTS_PROVIDER: 'off' } });
      try {
        const c = off.client();
        const a = await createMember(off, c, { email: 'a@example.com', handle: 'adminoff', name: 'A' });
        await makeAdmin(off, a.id);
        await off.ctx.db.query('UPDATE users SET totp_enabled_at = now() WHERE id = $1', [a.id]);
        for (const p of MONEY) assert.equal((await c.get(p)).status, 404, p);
        const home = (await c.get('/admin')).text;
        assert.ok(!home.includes('/admin/payouts') && !home.includes('Money held'));
      } finally {
        await off.close();
      }
    });
  });

  describe('reports', () => {
    test('child-safety reports come first, and what people typed is shown as text', async () => {
      await video('RRRRRRRRRR1', creator.id, 'A video <b>title</b>');
      await video('RRRRRRRRRR2', creator.id);
      await app.ctx.moderation.report({ reporterId: member.id, targetType: 'video', targetId: 'RRRRRRRRRR1', reason: 'spam', details: '<script>alert(1)</script>' });
      await app.ctx.moderation.report({ reporterId: member.id, targetType: 'video', targetId: 'RRRRRRRRRR2', reason: 'child_safety' });
      const page = (await modC.get('/admin/reports')).text;
      assert.ok(page.indexOf('Child safety') < page.indexOf('Spam or scam'), 'child safety first');
      assert.match(page, /Review first/);
      assert.ok(!page.includes('<script>alert(1)'));
      assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(page, /A video &lt;b&gt;title&lt;\/b&gt;/);
      assert.match((await modC.get('/admin')).text, /Child safety reports to review first/);
    });

    test('removing the video from a report tells the creator why and closes the report', async () => {
      const rep = await app.ctx.db.one(`SELECT id FROM reports WHERE target_id = 'RRRRRRRRRR1'`);
      const r = await modC.post(`/admin/reports/${rep.id}`, { decision: 'remove', [`note-${rep.id}`]: 'This is spam.' });
      assert.equal(r.status, 303);
      assert.equal((await app.ctx.db.one(`SELECT status FROM videos WHERE id = 'RRRRRRRRRR1'`)).status, 'removed');
      assert.equal((await app.ctx.db.one(`SELECT status FROM reports WHERE id = $1`, [rep.id])).status, 'actioned');
      const note = await app.ctx.db.one(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'policy'`, [creator.id]);
      assert.equal(note.data.reason, 'This is spam.');
      assert.equal(await flashOf(modC, '/admin/reports'), 'Saved.');
      const log = await app.ctx.db.one(`SELECT actor_id FROM audit_log WHERE action = 'report.remove'`);
      assert.equal(log.actor_id, mod.id);
    });

    test('a decision that is missing, unknown, or already made is refused politely', async () => {
      const rep = await app.ctx.db.one(`SELECT id FROM reports WHERE target_id = 'RRRRRRRRRR2'`);
      await modC.post(`/admin/reports/${rep.id}`, {});
      assert.match(await flashOf(modC, '/admin/reports'), /Choose a decision/);
      await modC.post(`/admin/reports/${rep.id}`, { decision: 'delete-everything' });
      assert.match(await flashOf(modC, '/admin/reports'), /Choose a decision/);
      assert.equal((await modC.post('/admin/reports/abc', { decision: 'dismiss' })).status, 404);
      await modC.post(`/admin/reports/${rep.id}`, { decision: 'dismiss' });
      await modC.post(`/admin/reports/${rep.id}`, { decision: 'dismiss' });
      assert.match(await flashOf(modC, '/admin/reports'), /already handled/);
    });
  });

  describe('report decisions are all-or-nothing', () => {
    let victim;
    before(async () => {
      victim = await createMember(app, app.client(), { email: 'victim@example.com', handle: 'victim1', name: 'Victim One' });
    });
    const reportOf = (targetId) => app.ctx.db.one(`SELECT id, status FROM reports WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, [targetId]);
    const auditCount = async (action) => (await app.ctx.db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = $1`, [action])).n;

    test('two reports about one person: suspending through the second one still closes it', async () => {
      await video('TTTTTTTTTT1', victim.id);
      await app.ctx.moderation.report({ reporterId: member.id, targetType: 'video', targetId: 'TTTTTTTTTT1', reason: 'harassment' });
      await app.ctx.moderation.report({ reporterId: mod.id, targetType: 'video', targetId: 'TTTTTTTTTT1', reason: 'hate' });
      const [first, second] = (await app.ctx.db.query(`SELECT id FROM reports WHERE target_id = 'TTTTTTTTTT1' ORDER BY id`)).rows;
      await adminC.post(`/admin/reports/${first.id}`, { decision: 'suspend', [`note-${first.id}`]: 'Repeated harassment' });
      assert.equal((await app.ctx.db.one('SELECT status FROM users WHERE id = $1', [victim.id])).status, 'suspended');
      await adminC.post(`/admin/reports/${second.id}`, { decision: 'suspend' });
      assert.equal(await flashOf(adminC, '/admin/reports'), 'Saved.');
      assert.equal((await app.ctx.db.one('SELECT status FROM reports WHERE id = $1', [second.id])).status, 'actioned');
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'user.suspend' AND target_id = $1`, [victim.id])).rows.length, 1, 'suspended once, not twice');
      await adminC.post(`/admin/users/${victim.id}/suspend`, { reason: 'once more' });
      assert.match(await flashOf(adminC, '/admin/users'), /not active/);
      await adminC.post(`/admin/users/${victim.id}/restore`, {});
      await adminC.post(`/admin/users/${victim.id}/restore`, {});
      assert.match(await flashOf(adminC, '/admin/users'), /not suspended/);
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'user.restore' AND target_id = $1`, [victim.id])).rows.length, 1, 'a restore that changed nothing is not logged');
    });

    test('a comment its author already deleted can still be closed with "remove"', async () => {
      await video('TTTTTTTTTT2', victim.id);
      const vid = await app.ctx.db.one(`SELECT * FROM videos WHERE id = 'TTTTTTTTTT2'`);
      const author = await app.ctx.db.one('SELECT * FROM users WHERE id = $1', [member.id]);
      const commentId = await app.ctx.comments.add({ user: author, video: vid, body: 'a rude comment' });
      await app.ctx.moderation.report({ reporterId: mod.id, targetType: 'comment', targetId: String(commentId), reason: 'harassment' });
      await app.ctx.comments.remove(commentId, author);
      const rep = await reportOf(String(commentId));
      const r = await modC.post(`/admin/reports/${rep.id}`, { decision: 'remove' });
      assert.equal(r.status, 303);
      assert.equal((await reportOf(String(commentId))).status, 'actioned');
      assert.equal(await flashOf(modC, '/admin/reports'), 'Saved.');
    });

    test('when the action fails, the report stays open and nothing is logged for it', async () => {
      await video('TTTTTTTTTT3', admin.id);
      await app.ctx.moderation.report({ reporterId: member.id, targetType: 'video', targetId: 'TTTTTTTTTT3', reason: 'other' });
      const rep = await reportOf('TTTTTTTTTT3');
      await modC.post(`/admin/reports/${rep.id}`, { decision: 'suspend' });
      assert.match(await flashOf(modC, '/admin/reports'), /Only an admin can suspend an admin/);
      assert.equal((await reportOf('TTTTTTTTTT3')).status, 'open');
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'report.suspend' AND target_id = 'TTTTTTTTTT3'`)).rows.length, 0);
      assert.equal((await app.ctx.db.one('SELECT status FROM users WHERE id = $1', [admin.id])).status, 'active');
      await adminC.post(`/admin/reports/${rep.id}`, { decision: 'dismiss' });
      assert.equal((await reportOf('TTTTTTTTTT3')).status, 'dismissed');
    });

    test('two staff acting on one report at once: exactly one decision is recorded and it matches what happened', async () => {
      await video('TTTTTTTTTT4', creator.id, 'Contested video');
      await app.ctx.moderation.report({ reporterId: member.id, targetType: 'video', targetId: 'TTTTTTTTTT4', reason: 'spam' });
      const rep = await reportOf('TTTTTTTTTT4');
      const beforeDismiss = await auditCount('report.dismiss');
      const beforeRemove = await auditCount('report.remove');
      await Promise.all([
        modC.post(`/admin/reports/${rep.id}`, { decision: 'dismiss' }),
        adminC.post(`/admin/reports/${rep.id}`, { decision: 'remove', [`note-${rep.id}`]: 'Spam.' }),
      ]);
      const now = await reportOf('TTTTTTTTTT4');
      const videoNow = (await app.ctx.db.one(`SELECT status FROM videos WHERE id = 'TTTTTTTTTT4'`)).status;
      const dismissed = (await auditCount('report.dismiss')) - beforeDismiss;
      const removed = (await auditCount('report.remove')) - beforeRemove;
      assert.equal(dismissed + removed, 1, 'one decision, not two');
      if (now.status === 'dismissed') assert.deepEqual({ dismissed, video: videoNow }, { dismissed: 1, video: 'ready' });
      else assert.deepEqual({ status: now.status, removed, video: videoNow }, { status: 'actioned', removed: 1, video: 'removed' });
    });

    test('a report that does not exist is a 404, one that was handled is a polite conflict', async () => {
      assert.equal((await modC.post('/admin/reports/987654321', { decision: 'dismiss' })).status, 404);
      const handled = await app.ctx.db.one(`SELECT id FROM reports WHERE status <> 'open' LIMIT 1`);
      await modC.post(`/admin/reports/${handled.id}`, { decision: 'dismiss' });
      assert.match(await flashOf(modC, '/admin/reports'), /already handled/);
    });
  });

  describe('people', () => {
    test('moderators see no email addresses, administrators do, and search treats % and _ as plain characters', async () => {
      const asMod = (await modC.get('/admin/users')).text;
      assert.ok(!asMod.includes('mem@example.com') && !asMod.includes('root@example.com'));
      const asAdmin = (await adminC.get('/admin/users')).text;
      assert.ok(asAdmin.includes('mem@example.com'));
      assert.ok((await adminC.get('/admin/users?q=mem@example')).text.includes('member1'));
      assert.ok(!(await modC.get('/admin/users?q=mem@example')).text.includes('member1'), 'a moderator cannot find people by email');
      const wild = (await adminC.get('/admin/users?q=%25')).text;
      assert.match(wild, /No one found/);
      assert.match((await adminC.get('/admin/users?q=creator_')).text, /No one found/, '_ is not a wildcard');
      const xss = (await adminC.get(`/admin/users?q=${encodeURIComponent('"><script>x</script>')}`)).text;
      assert.ok(!xss.includes('<script>x</script>'));
    });

    test('suspending needs a reason, signs the person out everywhere and is recorded; restoring undoes it', async () => {
      await modC.post(`/admin/users/${member.id}/suspend`, { reason: '' });
      assert.match(await flashOf(modC, '/admin/users'), /reason/i);
      assert.equal((await app.ctx.db.one('SELECT status FROM users WHERE id = $1', [member.id])).status, 'active');

      assert.equal((await memberC.get('/settings/profile')).status, 200);
      const r = await modC.post(`/admin/users/${member.id}/suspend`, { reason: 'Harassing other members' });
      assert.equal(r.status, 303);
      const row = await app.ctx.db.one('SELECT status, suspended_reason FROM users WHERE id = $1', [member.id]);
      assert.deepEqual({ s: row.status, r: row.suspended_reason }, { s: 'suspended', r: 'Harassing other members' });
      assert.equal((await memberC.get('/settings/profile')).status, 303, 'their session is gone');
      assert.equal((await app.ctx.db.one(`SELECT action FROM audit_log WHERE action = 'user.suspend'`)).action, 'user.suspend');

      assert.match((await modC.get('/admin/users?q=member1')).text, /Harassing other members/);
      await modC.post(`/admin/users/${member.id}/restore`, {});
      assert.equal((await app.ctx.db.one('SELECT status FROM users WHERE id = $1', [member.id])).status, 'active');
      assert.equal((await memberC.client?.() ?? null), null);
      const back = app.client();
      const login = await back.post('/login', { email: 'mem@example.com', password: PASSWORD });
      assert.equal(login.status, 303, 'they can sign in again');
    });

    test('moderators cannot suspend administrators or themselves, and ids that are not ids are not found', async () => {
      await modC.post(`/admin/users/${admin.id}/suspend`, { reason: 'because I can' });
      assert.match(await flashOf(modC, '/admin/users'), /Only an admin/);
      await modC.post(`/admin/users/${mod.id}/suspend`, { reason: 'myself' });
      assert.match(await flashOf(modC, '/admin/users'), /cannot suspend yourself/);
      assert.equal((await modC.post('/admin/users/not-a-uuid/suspend', { reason: 'xxx' })).status, 404);
      assert.equal((await app.ctx.db.one('SELECT status FROM users WHERE id = $1', [admin.id])).status, 'active');
    });

    test('only administrators change roles, never their own, and never another administrator’s', async () => {
      assert.equal((await modC.post(`/admin/users/${creator.id}/role`, { role: 'moderator' })).status, 404);
      await adminC.post(`/admin/users/${creator.id}/role`, { role: 'moderator' });
      assert.equal((await app.ctx.db.one('SELECT role FROM users WHERE id = $1', [creator.id])).role, 'moderator');
      await adminC.post(`/admin/users/${creator.id}/role`, { role: 'user' });
      assert.equal((await app.ctx.db.one('SELECT role FROM users WHERE id = $1', [creator.id])).role, 'user');
      await adminC.post(`/admin/users/${creator.id}/role`, { role: 'admin' });
      assert.match(await flashOf(adminC, '/admin/users'), /Choose a role/);
      assert.equal((await app.ctx.db.one('SELECT role FROM users WHERE id = $1', [creator.id])).role, 'user', 'admin cannot be granted from the web');
      await adminC.post(`/admin/users/${admin.id}/role`, { role: 'user' });
      assert.match(await flashOf(adminC, '/admin/users'), /cannot change your own role/);
      assert.equal((await app.ctx.db.one('SELECT role FROM users WHERE id = $1', [admin.id])).role, 'admin');
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'user.role_change'`)).rows.length, 2);
    });
  });

  describe('videos and messages', () => {
    test('a video can be removed with a reason and restored; bad ids are not found', async () => {
      await video('VVVVVVVVVV1', creator.id, 'Findable title');
      assert.match((await modC.get('/admin/videos?q=Findable')).text, /Findable title/);
      assert.match((await modC.get('/admin/videos?q=VVVVVVVVVV1')).text, /Findable title/);
      assert.match((await modC.get('/admin/videos?q=nothing-like-this')).text, /No videos found/);
      await modC.post('/admin/videos/VVVVVVVVVV1/remove', { reason: '' });
      assert.equal((await app.ctx.db.one(`SELECT status FROM videos WHERE id = 'VVVVVVVVVV1'`)).status, 'ready');
      await modC.post('/admin/videos/VVVVVVVVVV1/remove', { reason: 'Copyright claim upheld' });
      const gone = await app.ctx.db.one(`SELECT status, removed_reason, ad_status FROM videos WHERE id = 'VVVVVVVVVV1'`);
      assert.deepEqual({ s: gone.status, r: gone.removed_reason, a: gone.ad_status }, { s: 'removed', r: 'Copyright claim upheld', a: 'none' });
      assert.equal((await app.client().get('/watch/VVVVVVVVVV1')).status, 404, 'visitors can no longer watch it');
      assert.match((await modC.get('/admin/videos?status=removed')).text, /Copyright claim upheld/);
      await modC.post('/admin/videos/VVVVVVVVVV1/remove', { reason: 'again please' });
      assert.match(await flashOf(modC, '/admin/videos'), /already removed/);
      await modC.post('/admin/videos/VVVVVVVVVV1/restore', {});
      assert.equal((await app.ctx.db.one(`SELECT status FROM videos WHERE id = 'VVVVVVVVVV1'`)).status, 'ready');
      assert.equal((await modC.post('/admin/videos/short/remove', { reason: 'xxx' })).status, 404);
    });

    test('messages from people are shown as text, can be handled and reopened, and moderators do not see members’ emails', async () => {
      const c = app.client();
      await c.post('/contact', { email: 'visitor@example.com', subject: 'Help <b>please</b>', message: 'Line one\n<script>alert(1)</script>', topic: 'other', website: '' });
      await app.ctx.db.query(`INSERT INTO contact_messages (user_id, email, subject, body) VALUES ($1, 'mem@example.com', 'From a member', 'Hello')`, [member.id]);
      const asMod = (await modC.get('/admin/messages')).text;
      assert.ok(!asMod.includes('<script>alert(1)'));
      assert.match(asMod, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.ok(asMod.includes('visitor@example.com'), 'an address from a visitor without an account is shown so staff can reply');
      assert.ok(!asMod.includes('mem@example.com'), 'a member’s address is for administrators');
      assert.ok((await adminC.get('/admin/messages')).text.includes('mem@example.com'));
      const id = (await app.ctx.db.one(`SELECT id FROM contact_messages WHERE subject = 'From a member'`)).id;
      await modC.post(`/admin/messages/${id}/status`, { status: 'closed' });
      assert.equal((await app.ctx.db.one('SELECT status FROM contact_messages WHERE id = $1', [id])).status, 'closed');
      assert.ok(!(await modC.get('/admin/messages')).text.includes('From a member'));
      assert.ok((await modC.get('/admin/messages?status=closed')).text.includes('From a member'));
      await modC.post(`/admin/messages/${id}/status`, { status: 'open' });
      assert.equal((await app.ctx.db.one('SELECT status FROM contact_messages WHERE id = $1', [id])).status, 'open');
      await modC.post(`/admin/messages/${id}/status`, { status: 'whatever' });
      assert.match(await flashOf(modC, '/admin/messages'), /Unknown status/);
      assert.equal((await modC.post('/admin/messages/999999/status', { status: 'closed' })).status, 404);
    });
  });

  describe('money', () => {
    test('the payout queue: approve, show where to pay (password needed, logged), mark paid', async () => {
      await tipPaid(100_000);
      app.clock.advance(8 * DAY);
      await creatorC.post('/studio/payouts/details', { method: 'upi', upi: 'creator@okbank', password: PASSWORD });
      app.clock.advance(2 * DAY);
      const id = await app.ctx.monetization.requestPayout(creator.id, 50_000);

      const queue = (await adminC.get('/admin/payouts')).text;
      assert.match(queue, /₹500\.00/);
      assert.match(queue, /cr••••@okbank/);
      assert.ok(!queue.includes('creator@okbank'), 'the list never shows the full address');

      await adminC.post(`/admin/payouts/${id}/reveal`, { password: 'wrong' });
      assert.match(await flashOf(adminC, '/admin/payouts'), /not your password/);
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'payout.reveal_details'`)).rows.length, 0, 'a failed attempt reveals nothing and logs no reveal');

      const shown = await adminC.post(`/admin/payouts/${id}/reveal`, { password: PASSWORD });
      assert.equal(shown.status, 200);
      assert.match(shown.text, /creator@okbank/);
      assert.equal(shown.header('cache-control'), 'no-store');
      assert.match(shown.text, /written to the audit log/);
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'payout.reveal_details' AND actor_id = $1`, [admin.id])).rows.length, 1);

      await adminC.post(`/admin/payouts/${id}/approve`, {});
      assert.equal((await app.ctx.db.one('SELECT status FROM payouts WHERE id = $1', [id])).status, 'approved');
      await adminC.post(`/admin/payouts/${id}/paid`, { reference: '' });
      assert.match(await flashOf(adminC, '/admin/payouts'), /payment reference/i);
      await adminC.post(`/admin/payouts/${id}/paid`, { reference: 'UTR123456' });
      const p = await app.ctx.db.one('SELECT status, paid_reference FROM payouts WHERE id = $1', [id]);
      assert.deepEqual({ s: p.status, r: p.paid_reference }, { s: 'paid', r: 'UTR123456' });
      assert.ok((await adminC.get('/admin/payouts?status=paid')).text.includes('UTR123456'));
      assert.equal((await adminC.post('/admin/payouts/not-a-uuid/approve', {})).status, 404);
    });

    test('an administrator’s own payout request is flagged and cannot be handled by them', async () => {
      await app.ctx.db.query(`UPDATE users SET creator_terms_version = $2 WHERE id = $1`, [admin.id, (await app.ctx.db.one('SELECT creator_terms_version AS v FROM users WHERE id = $1', [creator.id])).v]);
      const payer = await app.ctx.db.one('SELECT * FROM users WHERE id = $1', [member.id]);
      const { paymentId } = await app.ctx.monetization.createTip({ payer, channelId: admin.id, amountMinor: 100_000 });
      await app.ctx.monetization.applyProviderEvent({ id: `own-${paymentId}`, rawType: 'x', type: 'paid', providerRef: `test_${paymentId}`, amountMinor: 100_000, currency: 'INR', paidAt: null });
      app.clock.advance(8 * DAY);
      await adminC.post('/studio/payouts/details', { method: 'upi', upi: 'boss@okbank', password: PASSWORD });
      app.clock.advance(2 * DAY);
      const id = await app.ctx.monetization.requestPayout(admin.id, 50_000);
      const queue = (await adminC.get('/admin/payouts')).text;
      assert.match(queue, /This is your own request/);
      assert.ok(!queue.includes(`/admin/payouts/${id}/approve`), 'no buttons for it');
      await adminC.post(`/admin/payouts/${id}/paid`, { reference: 'SELF1' });
      assert.match(await flashOf(adminC, '/admin/payouts'), /your own/);
      assert.equal((await app.ctx.db.one('SELECT status FROM payouts WHERE id = $1', [id])).status, 'requested');
      assert.equal((await adminC.post(`/admin/payouts/${id}/reveal`, { password: PASSWORD })).status, 404);
      await app.ctx.monetization.cancelPayout(admin.id, id);
    });

    test('declining returns the money and needs a reason', async () => {
      await tipPaid(100_000);
      app.clock.advance(8 * DAY);
      const id = await app.ctx.monetization.requestPayout(creator.id, 50_000);
      const before = (await app.ctx.monetization.balances(creator.id)).available;
      await adminC.post(`/admin/payouts/${id}/reject`, { reason: '' });
      assert.match(await flashOf(adminC, '/admin/payouts'), /reason/i);
      await adminC.post(`/admin/payouts/${id}/reject`, { reason: 'Name does not match' });
      assert.equal((await app.ctx.monetization.balances(creator.id)).available, before + 50_000);
    });

    test('a refund takes the tip out of the creator’s balance, once', async () => {
      const id = await tipPaid(30_000);
      const before = (await app.ctx.monetization.balances(creator.id)).total;
      assert.match((await adminC.get('/admin/payments?status=paid')).text, /Refund/);
      await adminC.post(`/admin/payments/${id}/refund`, { reason: '' });
      assert.equal((await app.ctx.db.one('SELECT status FROM payments WHERE id = $1', [id])).status, 'paid');
      await adminC.post(`/admin/payments/${id}/refund`, { reason: 'Payer was charged twice' });
      assert.equal((await app.ctx.db.one('SELECT status FROM payments WHERE id = $1', [id])).status, 'refunded');
      assert.equal((await app.ctx.monetization.balances(creator.id)).total, before - 27_000);
      assert.match(await flashOf(adminC, '/admin/payments'), /Refund recorded/);
      await adminC.post(`/admin/payments/${id}/refund`, { reason: 'again please' });
      assert.match(await flashOf(adminC, '/admin/payments'), /only once/);
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM ledger_entries WHERE kind = 'refund' AND ref_id = $1`, [id])).rows.length, 2);
    });

    test('revenue shares: AdSense needs the permission box, the preview shows who gets what, posting needs a tick and happens once', async () => {
      await video('SSSSSSSSSS1', creator.id);
      await app.ctx.db.query(`INSERT INTO video_view_days (video_id, day, viewer_hash, watch_ms, qualified, counted, last_beat_at) VALUES ('SSSSSSSSSS1', '2026-10-10', 'h1', 3600000, true, true, now())`);
      const form = { label: 'October sponsor', source: 'sponsorship', gross: '10000', share: '70', periodStart: '2026-10-01', periodEnd: '2026-10-31' };

      const adsense = await adminC.post('/admin/revenue', { ...form, source: 'adsense' });
      assert.equal(adsense.status, 422);
      assert.match(adsense.text, /Google’s AdSense program policies do not allow passing AdSense earnings/);
      assert.ok(adsense.text.includes('value="October sponsor"'), 'the form keeps what was typed');
      assert.equal((await app.ctx.db.query('SELECT 1 FROM revenue_batches')).rows.length, 0);

      for (const bad of [{ gross: 'lots' }, { gross: '0' }, { share: '101' }, { share: 'abc' }, { share: '' }, { periodEnd: '2026-09-01' }, { label: '' }]) {
        const r = await adminC.post('/admin/revenue', { ...form, ...bad });
        assert.equal(r.status, 422, JSON.stringify(bad));
      }
      assert.equal((await app.ctx.db.query('SELECT 1 FROM revenue_batches')).rows.length, 0);

      const ok = await adminC.post('/admin/revenue', form);
      assert.equal(ok.status, 303);
      const page = await adminC.get(ok.location);
      assert.match(page.text, /Draft: nothing booked yet/);
      assert.match(page.text, /₹7,000\.00/);
      assert.match(page.text, /@creator1/);
      assert.match(page.text, /1\.0 hours/);

      const noTick = await adminC.post(`${ok.location}/post`, {});
      assert.equal(noTick.status, 422);
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM ledger_entries WHERE kind = 'revenue_share'`)).rows.length, 0);
      const posted = await adminC.post(`${ok.location}/post`, { confirm: '1' });
      assert.equal(posted.status, 303);
      assert.equal((await app.ctx.db.one(`SELECT amount_minor FROM ledger_entries WHERE kind = 'revenue_share'`)).amount_minor, 700_000);
      const again = await adminC.post(`${ok.location}/post`, { confirm: '1' });
      assert.equal(again.status, 409);
      assert.match(again.text, /already been posted/);
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM ledger_entries WHERE kind = 'revenue_share'`)).rows.length, 1);
      assert.match((await adminC.get('/admin/revenue')).text, /Posted/);

      const withPermission = await adminC.post('/admin/revenue', { ...form, source: 'adsense', label: 'AdSense, permitted', google_permission: '1' });
      assert.equal(withPermission.status, 303);
      assert.match((await adminC.get(withPermission.location)).text, /permission stated/);
      assert.equal((await adminC.get('/admin/revenue/not-a-uuid')).status, 404);
    });

    test('the overview shows what the site holds for creators', async () => {
      const page = (await adminC.get('/admin')).text;
      assert.match(page, /Money held/);
      assert.match(page, /Owed to creators/);
      assert.match(page, /Platform fees earned/);
      assert.ok(!(await modC.get('/admin')).text.includes('Money held'));
    });
  });

  describe('jobs and the audit log', () => {
    test('a failed job can be queued again, once', async () => {
      const row = await app.ctx.db.one(`INSERT INTO jobs (kind, status, attempts, last_error, finished_at) VALUES ('transcode', 'failed', 3, 'ffmpeg exited with 1 <b>boom</b>', now()) RETURNING id`);
      const page = (await adminC.get('/admin/jobs')).text;
      assert.match(page, /ffmpeg exited with 1 &lt;b&gt;boom&lt;\/b&gt;/);
      await adminC.post(`/admin/jobs/${row.id}/retry`, {});
      const j = await app.ctx.db.one('SELECT status, attempts FROM jobs WHERE id = $1', [row.id]);
      assert.deepEqual({ s: j.status, a: j.attempts }, { s: 'queued', a: 0 });
      await adminC.post(`/admin/jobs/${row.id}/retry`, {});
      assert.match(await flashOf(adminC, '/admin/jobs'), /not in the failed list/);
      await app.ctx.db.query('DELETE FROM jobs WHERE id = $1', [row.id]);
    });

    test('the audit log lists who did what, and holds no passwords or payout details', async () => {
      const page = (await adminC.get('/admin/audit')).text;
      for (const action of ['user.suspend', 'user.restore', 'user.role_change', 'payout.reveal_details', 'payout.paid', 'payment.refund', 'revenue.batch_post', 'video.remove']) assert.ok(page.includes(action), action);
      assert.ok(page.includes('@moddy') && page.includes('@rootadmin'));
      const raw = JSON.stringify((await app.ctx.db.query('SELECT meta, action, target_id FROM audit_log')).rows);
      for (const secret of [PASSWORD, 'creator@okbank', 'boss@okbank', 'UTR123456'.toLowerCase() === 'x' ? 'x' : 'correct horse']) assert.ok(!raw.includes(secret), `audit log must not contain ${secret}`);
      assert.ok((await adminC.get('/admin/audit?page=2')).status === 200);
    });
  });
});
