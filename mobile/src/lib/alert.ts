import { Alert as NativeAlert, Platform } from 'react-native';

/**
 * `Alert.alert` multiplateforme.
 *
 * `react-native-web` exporte bien un `Alert`, mais son `alert()` est une
 * fonction vide : côté navigateur, aucune des boîtes de confirmation et aucun
 * des messages d'erreur de l'application ne s'affichait — les actions
 * « Supprimer », « Valider la vente », « Résoudre le conflit » échouaient en
 * silence (bouton sans effet).
 *
 * Ce module garde la signature utilisée par les écrans (titre, message,
 * boutons) et la traduit :
 * - natif : `Alert.alert` de React Native ;
 * - web : `window.confirm` quand une confirmation est demandée, `window.alert`
 *   pour un simple message (le bouton « Annuler » est le repli en cas de refus).
 */

export interface AlertButton {
  text?: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

/** Bouton attendu par l'API native (`react-native` ne publie pas ce type). */
type NativeAlertButton = NonNullable<Parameters<typeof NativeAlert.alert>[2]>[number];

/** Bouton exécuté quand l'utilisateur confirme : le destructif d'abord, sinon le premier actif. */
function acceptButton(buttons: AlertButton[]): AlertButton | undefined {
  return (
    buttons.find((b) => b.style === 'destructive') ??
    buttons.find((b) => b.style !== 'cancel' && b.onPress) ??
    buttons.find((b) => b.style !== 'cancel')
  );
}

/** Bouton de refus : `style: 'cancel'`, sinon le premier (convention de l'app : « Annuler »). */
function cancelButton(buttons: AlertButton[]): AlertButton | undefined {
  return buttons.find((b) => b.style === 'cancel') ?? (buttons.length > 1 ? buttons[0] : undefined);
}

function alertWeb(title?: string, message?: string, buttons?: AlertButton[]): void {
  const list = buttons ?? [];
  const head = [title, message].filter(Boolean).join('\n');

  if (list.length === 0) {
    window.alert(head);
    return;
  }
  if (list.length === 1) {
    window.alert(head);
    list[0].onPress?.();
    return;
  }
  if (window.confirm(head)) acceptButton(list)?.onPress?.();
  else cancelButton(list)?.onPress?.();
}

export const Alert = {
  alert(title?: string, message?: string, buttons?: AlertButton[]): void {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        alertWeb(title, message, buttons);
        return;
      }
      // Environnement sans fenêtre (tests) : on trace plutôt que perdre l'information.
      // eslint-disable-next-line no-console
      console.info([title, message].filter(Boolean).join(' — '));
      acceptButton(buttons ?? [])?.onPress?.();
      return;
    }
    NativeAlert.alert(title ?? '', message, buttons as NativeAlertButton[]);
  },
};
