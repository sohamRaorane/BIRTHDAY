import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const baseURL = 'http://localhost:5173';

async function joinFromInvite(context: BrowserContext, inviteUrl: string, name: string) {
  const page = await context.newPage();
  await page.goto(inviteUrl);
  await expect(page.getByRole('heading', { name: 'Join meeting.' })).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.getByRole('heading', { name: 'Meeting Room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat' })).toBeVisible();
  return page;
}

test('secret birthday invite privacy, organizer controls, reveal, media defaults, and chat', async ({ browser, page }) => {
  await page.goto('/');
  await page.screenshot({ path: 'test-results/landing-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/landing-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account.' })).toBeVisible();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await page.getByLabel('Your name').fill(`Organizer ${suffix}`);
  await page.getByLabel('Email address').fill(`organizer-${suffix}@example.test`);
  await page.getByLabel('Password').fill('SecretBirthday!2026');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('button', { name: 'Create a meeting' }).first().click();
  await page.getByLabel('Room name').fill('Meeting Room');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { name: 'Meeting Room' })).toBeVisible();
  const createdRoom = await roomIdFromSnapshot(page);
  const organizerSession = await page.request.get('/api/v1/meetings/current');
  expect(organizerSession.ok()).toBeTruthy();
  expect((await organizerSession.json()).snapshot.id).toBe(createdRoom);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Meeting Room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Organizer controls' })).toBeVisible();
  await page.getByRole('button', { name: 'Organizer controls' }).click();
  await page.locator('.organizer-drawer').getByRole('button', { name: 'Close' }).click();
  await page.locator('.room-head-actions').getByRole('button', { name: 'Copy participant link' }).click();
  await page.getByRole('button', { name: 'Organizer controls' }).click();
  await expect(page.locator('.birthday-link code').first()).toBeVisible();
  const birthdayLink = await page.locator('.birthday-link code').first().textContent();
  expect(birthdayLink).toContain('/join/');

  await page.locator('.organizer-drawer').getByRole('button', { name: 'Create invitation' }).click();
  const hiddenInvite = page.locator('.birthday-link').filter({ hasText: 'Guest invitation' });
  await expect(hiddenInvite).toBeVisible();
  const hiddenLink = await hiddenInvite.locator('code').textContent();
  expect(hiddenLink).toContain('token=');
  await page.locator('.organizer-drawer').getByRole('button', { name: 'Close' }).click();

  const birthdayContext = await browser.newContext();
  const birthdayPage = await joinFromInvite(birthdayContext, birthdayLink!, 'Birthday Person');
  await expect(birthdayPage.getByRole('button', { name: 'Turn mic on' })).toBeEnabled();
  await birthdayPage.screenshot({ path: 'test-results/meeting-desktop.png', fullPage: true });
  await birthdayPage.setViewportSize({ width: 390, height: 844 });
  await birthdayPage.screenshot({ path: 'test-results/meeting-mobile.png', fullPage: true });
  await birthdayPage.setViewportSize({ width: 1280, height: 900 });
  const normalUiText = await birthdayPage.locator('body').innerText();
  expect(normalUiText.replaceAll('Birthday Person', '')).not.toMatch(/birthday|surprise|secret|hidden/i);
  await expect(birthdayPage.locator('.room-heading')).toContainText('Meeting Room');
  const birthdayMeetingId = await roomIdFromSnapshot(birthdayPage);
  const birthdayToken = await birthdayPage.evaluate((id) => JSON.parse(sessionStorage.getItem(`livekit:${id}`) || '{}').token, birthdayMeetingId);
  const birthdayGrant = JSON.parse(Buffer.from(birthdayToken.split('.')[1], 'base64url').toString());
  expect(birthdayGrant.video.hidden).toBe(true);
  await birthdayPage.reload();
  await expect(birthdayPage.getByRole('heading', { name: 'Meeting Room' })).toBeVisible();
  await expect(birthdayPage.getByRole('button', { name: 'Turn mic on' })).toBeEnabled();
  expect(await roomIdFromSnapshot(birthdayPage)).toBe(birthdayMeetingId);
  const friendContext = await browser.newContext();
  const friendPage = await joinFromInvite(friendContext, hiddenLink!, 'Hidden Friend');
  await expect(friendPage.getByRole('button', { name: 'Turn mic on' })).toBeEnabled();
  await expect(birthdayPage.locator('.people-strip')).not.toContainText('Hidden Friend');
  await birthdayPage.getByRole('button', { name: 'People' }).click();
  const birthdayPeople = birthdayPage.locator('.people-list');
  await expect(birthdayPeople).not.toContainText('Birthday Person');
  await expect(birthdayPeople).not.toContainText('Hidden Friend');

  const snapshotResponse = await birthdayPage.request.get(`/api/v1/meetings/${await roomIdFromSnapshot(birthdayPage)}/snapshot`);
  expect(snapshotResponse.ok()).toBeTruthy();
  const snapshot = await snapshotResponse.json();
  expect(JSON.stringify(snapshot)).not.toContain('Hidden Friend');
  expect(snapshot.snapshot.participants).toHaveLength(0);
  expect(JSON.stringify(snapshot).replaceAll('Birthday Person', '')).not.toMatch(/birthday|surprise|secret|hidden/i);
  expect(snapshot.snapshot.status).toBe('ACTIVE');
  expect(snapshot.snapshot.state).toBe('WAITING');
  expect(snapshot.snapshot).not.toHaveProperty('surpriseState');
  expect(snapshot.snapshot).not.toHaveProperty('birthdayMessage');
  expect(JSON.stringify(snapshot)).not.toMatch(/BIRTHDAY_GUEST|HIDDEN|ready|fileName|byteSize/i);
  const meetingId = snapshot.snapshot.id;
  const unauthorizedRoster = await birthdayPage.request.get(`/api/v1/meetings/${meetingId}/organizer/participants`);
  expect([401, 403]).toContain(unauthorizedRoster.status());

  // An unrelated participant session must not be able to invoke organizer controls.
  for (const action of ['reveal', 'end']) {
    const response = await birthdayPage.request.post(`/api/v1/meetings/${meetingId}/organizer/${action}`, { data: {} });
    expect([401, 403], `${action} should reject a birthday participant`).toContain(response.status());
  }
  const unauthorizedUpload = await birthdayPage.request.post(`/api/v1/meetings/${meetingId}/organizer/media`, {
    multipart: { file: { name: 'unauthorized.webm', mimeType: 'video/webm', buffer: Buffer.from('not a video') } },
  });
  expect([401, 403], 'media upload should reject a birthday participant').toContain(unauthorizedUpload.status());

  await page.getByRole('button', { name: 'Organizer controls' }).click();
  await expect(page.locator('.drawer-roster')).toContainText('Birthday Person');
  await expect(page.locator('.drawer-roster')).toContainText('Hidden Friend');
  await expect(page.locator('.drawer-roster')).toContainText(`Organizer ${suffix}`);

  // Record a short real WebM in Chromium, then upload it through the organizer file picker.
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(8);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    for (let frame = 0; frame < 6; frame++) {
      ctx.fillStyle = `rgb(${frame * 30},80,160)`;
      ctx.fillRect(0, 0, 64, 64);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    recorder.stop();
    const blob = await finished;
    stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  expect(videoBytes.length).toBeGreaterThan(100);
  await page.locator('input[type="file"]').setInputFiles({ name: 'tiny-birthday.webm', mimeType: 'video/webm', buffer: Buffer.from(videoBytes) });
  await expect(page.getByText(/Ready to preview: tiny-birthday\.webm/)).toBeVisible();
  const birthdayMedia = await birthdayPage.request.get(`/api/v1/meetings/${meetingId}/media`);
  expect(birthdayMedia.status()).toBe(404);
  
  const birthdayMediaMetadata = await birthdayPage.request.get(`/api/v1/meetings/${meetingId}/snapshot`);
  const metadataBeforePlayback = await birthdayMediaMetadata.json();
  expect(metadataBeforePlayback.snapshot.media).toBeUndefined();
  expect(metadataBeforePlayback.snapshot.title).toBe('Meeting Room');

  await page.getByRole('button', { name: 'Start shared media' }).click();
  await expect.poll(async () => (await (await birthdayPage.request.get(`/api/v1/meetings/${meetingId}/snapshot`)).json()).snapshot.state).toBe('MEDIA_PLAYING');
  await expect(birthdayPage.locator('.birthday-video video')).toHaveAttribute('src', new RegExp(`/api/v1/meetings/${meetingId}/media`));
  await birthdayPage.locator('.birthday-video video').evaluate(video => video.dispatchEvent(new Event('ended')));
  await expect.poll(async () => (await (await birthdayPage.request.get(`/api/v1/meetings/${meetingId}/snapshot`)).json()).snapshot.state).toBe('MEDIA_PLAYING');

  await page.getByRole('button', { name: 'Make the big reveal' }).click();
  await expect(birthdayPage.locator('.people-list')).not.toContainText('Hidden Friend');
  await expect(friendPage.locator('.people-strip')).not.toContainText('Hidden Friend');
  const revealed = await birthdayPage.request.get(`/api/v1/meetings/${meetingId}/snapshot`);
  const revealedSnapshot = await revealed.json();
  expect(revealedSnapshot.snapshot.participants).toHaveLength(0);
  expect(revealedSnapshot.snapshot.participants.every((p: { cameraEnabled: boolean; microphoneEnabled: boolean }) => !p.cameraEnabled && !p.microphoneEnabled)).toBe(true);
  await expect(birthdayPage.getByRole('button', { name: 'Turn mic on' })).toBeVisible();
  await expect(birthdayPage.getByRole('button', { name: 'Turn camera on' })).toBeVisible();

  await birthdayPage.getByRole('button', { name: 'Chat' }).click();
  const chatText = `Happy birthday from E2E ${suffix}`;
  await birthdayPage.getByRole('textbox', { name: 'Chat message' }).fill(chatText);
  await birthdayPage.getByRole('button', { name: 'Send' }).click();
  await expect(birthdayPage.locator('.chat-list')).toContainText(chatText);
  await expect(page.locator('.chat-list')).toContainText(chatText);

  await birthdayContext.close();
  await friendContext.close();
});

async function roomIdFromSnapshot(page: Page): Promise<string> {
  // Participant sessions are intentionally distinct from user authentication sessions.
  const meetingId = await page.evaluate(() => Object.keys(sessionStorage).find(key => key.startsWith('livekit:'))?.slice('livekit:'.length));
  expect(meetingId).toBeTruthy();
  return meetingId!;
}
