// Full reviewer journey in a real browser against the real server (fresh DB, no LLM key ⇒ heuristic path).
// Covers: empty state → draft → validation-blocked approval → clarification patches → dry run (determinism, evidence)
// → approval → gated execute with a simulated failure → retry without duplicates → reconcile → rollback → history/logs.
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const tab = (page: Page, name: RegExp) => page.getByRole('navigation', { name: 'Workflow steps' }).getByRole('button', { name });

test.describe.configure({ mode: 'serial' });

test('reviewer journey: plan → approve → dry run → execute (fail + retry) → reconcile → rollback', async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await test.step('empty states before any plan exists', async () => {
    await page.goto('/#review');
    await expect(page.getByText('No plan versions yet')).toBeVisible();
    await tab(page, /Reconcile/).click();
    await expect(page.getByText(/Not executed yet/i).first()).toBeVisible();
  });

  await test.step('generate the deterministic draft (AI not configured on this server)', async () => {
    await tab(page, /Proposal/).click();
    await expect(page.getByRole('button', { name: 'Run AI agent' })).toBeDisabled();
    await page.getByPlaceholder('your name').fill('Alice Reviewer');
    await page.getByRole('button', { name: 'Generate heuristic draft', exact: true }).click();
    await page.getByRole('button', { name: /Review v1/ }).first().click();
    await expect(page.getByText('5 approval blockers')).toBeVisible();
    await shot(page, '10-review-v1');
  });

  await test.step('approval is blocked while blockers exist (validation state)', async () => {
    await page.getByRole('button', { name: 'Approve…' }).click();
    await expect(page.getByRole('button', { name: 'Approve v1' })).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  });

  await test.step('answer every clarification with a deterministic patch (new version each time)', async () => {
    const answers = [/Treat empty as 0/, /Default to 'US'/, /Quarantine the 5 rows/, /Keep US month\/day/];
    for (const [i, label] of answers.entries()) {
      await page.getByRole('button', { name: label }).click();
      await expect(page.getByText(`Saved as v${i + 2}`).first()).toBeVisible();
    }
    await expect(page.getByText('No open questions').or(page.getByText(/0 open/)).first()).toBeVisible();
  });

  await test.step('dry run is deterministic and keeps field-level evidence', async () => {
    await tab(page, /Dry run/).click();
    const run = page.getByRole('button', { name: 'Run dry run of v5' }).first();
    await run.click();
    await expect(page.getByText('Source', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('200').first()).toBeVisible();
    await run.click();
    await expect(page.getByText(/identical to previous dry run/i).first()).toBeVisible();
    await expect(page.getByText('MISSING_REQUIRED').first()).toBeVisible();
    await shot(page, '11-dry-run');
  });

  await test.step('execute is refused before approval (409 gate surfaced in the UI)', async () => {
    const res = await request.post('/api/runs/execute', { data: { version: 5 } });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe('NOT_APPROVED');
    await tab(page, /Execute/).click();
    await expect(page.getByText('Approve a plan version first')).toBeVisible();
  });

  await test.step('approve v5 with a named reviewer', async () => {
    await tab(page, /Review/).click();
    await page.getByRole('button', { name: 'Approve…' }).click();
    await page.getByRole('button', { name: 'Approve v5' }).click();
    await expect(page.getByText(/approved by Alice Reviewer/i).first()).toBeVisible();
  });

  await test.step('a simulated failure leaves the load INCOMPLETE; retry finishes it with no duplicates', async () => {
    await tab(page, /Execute/).click();
    await page.getByLabel('Simulate a failure after').check();
    await page.getByRole('button', { name: 'Execute v5 (fail after 75)' }).click();
    await expect(page.getByText('FAULT_INJECTED').first()).toBeVisible();
    await tab(page, /Reconcile/).click();
    await expect(page.getByText(/Incomplete/i).first()).toBeVisible();
    await tab(page, /Execute/).click();
    await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
    await expect(page.getByText(/retried by #/i).first()).toBeVisible();
    await shot(page, '12-execute-retry');
    const dupes = await request.get('/api/target/accounts?limit=200');
    const refs = ((await dupes.json()).items as { external_ref: string }[]).map((r) => r.external_ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.length).toBe(166); // 5 pre-existing + 161 loaded (3 target conflicts quarantined)
  });

  await test.step('reconcile: totals match', async () => {
    await tab(page, /Reconcile/).click();
    await expect(page.getByText('Matched').first()).toBeVisible();
    await shot(page, '13-reconcile');
  });

  await test.step('rollback removes only this workspace’s rows', async () => {
    await page.getByRole('button', { name: "Roll back this workspace's loaded rows…" }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^Roll back/ }).click();
    await expect(page.getByText(/Rolled back 161 rows/i).first()).toBeVisible();
    await expect(page.getByText(/Rolled back cleanly/i).first()).toBeVisible();
    const after = await (await request.get('/api/target/accounts?limit=200')).json();
    expect(after.total).toBe(5);
  });

  await test.step('history shows approvals, executions, retry and rollback; logs are browsable', async () => {
    await tab(page, /History/).click();
    for (const label of ['plan approved', 'execution failed', 'execution retried', 'rollback completed']) {
      await expect(page.getByText(new RegExp(`^${label}`)).filter({ visible: true }).first()).toBeVisible();
    }
    await shot(page, '14-history');
    await tab(page, /Logs/).click();
    await expect(page.getByText('request').first()).toBeVisible();
  });

  expect(consoleErrors).toEqual([]);
});
