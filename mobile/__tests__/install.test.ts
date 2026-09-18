import { buildInstallPlan, detectPlatform } from '../src/lib/installApp';

/**
 * Raccourci d'installation : détection de la plateforme et plan affiché.
 * (Fonctions pures — l'invite navigateur elle-même est couverte par le
 * smoke test web `npm run smoke:web`.)
 */

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  desktopEdge:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
};

describe('detectPlatform', () => {
  it('reconnaît Android, iOS et le bureau', () => {
    expect(detectPlatform(UA.androidChrome)).toBe('android');
    expect(detectPlatform(UA.iphoneSafari)).toBe('ios');
    expect(detectPlatform(UA.desktopChrome)).toBe('desktop');
    expect(detectPlatform(UA.desktopEdge)).toBe('desktop');
  });

  it('ne confond pas Edge/Chrome macOS avec un iPad', () => {
    expect(detectPlatform(UA.desktopEdge)).not.toBe('ios');
  });

  it('retombe sur « desktop » quand l’User-Agent est vide', () => {
    expect(detectPlatform('')).toBe('desktop');
  });
});

describe('buildInstallPlan', () => {
  it('propose l’invite d’installation quand le navigateur la fournit', () => {
    const plan = buildInstallPlan({ userAgent: UA.androidChrome, canPrompt: true, installed: false });
    expect(plan.actionable).toBe(true);
    expect(plan.platform).toBe('android');
    expect(plan.showApkLink).toBe(true); // repli APK proposé en second bouton
    expect(plan.buttonLabel).toMatch(/Installer/);
  });

  it('parle d’application de bureau sur PC', () => {
    const plan = buildInstallPlan({ userAgent: UA.desktopChrome, canPrompt: true, installed: false });
    expect(plan.actionable).toBe(true);
    expect(plan.buttonLabel).toMatch(/bureau/);
    expect(plan.hint).toMatch(/menu Démarrer/i);
    expect(plan.showApkLink).toBe(false);
  });

  it('explique la procédure Safari sur iOS (aucune invite possible)', () => {
    const plan = buildInstallPlan({ userAgent: UA.iphoneSafari, canPrompt: false, installed: false });
    expect(plan.actionable).toBe(false);
    expect(plan.platform).toBe('ios');
    expect(plan.hint).toMatch(/Safari/);
    expect(plan.showApkLink).toBe(false);
  });

  it('bascule sur le téléchargement de l’APK quand Android n’a pas d’invite', () => {
    const plan = buildInstallPlan({ userAgent: UA.androidChrome, canPrompt: false, installed: false });
    expect(plan.actionable).toBe(false);
    expect(plan.showApkLink).toBe(true);
    expect(plan.buttonLabel).toMatch(/APK/);
  });

  it('signale l’application déjà installée et ne propose plus d’action', () => {
    const plan = buildInstallPlan({ userAgent: UA.desktopChrome, canPrompt: false, installed: true });
    expect(plan.installed).toBe(true);
    expect(plan.actionable).toBe(false);
    expect(plan.showApkLink).toBe(false);
    expect(plan.title).toMatch(/installée/i);
  });
});
