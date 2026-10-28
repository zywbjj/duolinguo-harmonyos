import { abilityAccessCtrl, common } from '@kit.AbilityKit';

export class WebPermissionService {
  private static pending: Promise<boolean> | undefined = undefined;

  // A window change can leave an OS dialog open. Share that request across all Web windows.
  static hasMicrophone(context: common.UIAbilityContext): boolean {
    try {
      return abilityAccessCtrl.createAtManager().checkAccessTokenSync(context.applicationInfo.accessTokenId,
        'ohos.permission.MICROPHONE') === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
    } catch { return false; }
  }

  static requestMicrophone(context: common.UIAbilityContext, allowPrompt: boolean = true): Promise<boolean> {
    // Always read the current OS state, including after the user changes it in Settings.
    if (WebPermissionService.hasMicrophone(context)) { return Promise.resolve(true); }
    if (!allowPrompt) { return Promise.resolve(false); }
    if (!WebPermissionService.pending) {
      WebPermissionService.pending = WebPermissionService.ask(context).finally(() => {
        WebPermissionService.pending = undefined;
      });
    }
    return WebPermissionService.pending;
  }

  private static async ask(context: common.UIAbilityContext): Promise<boolean> {
    try {
      const result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context,
        ['ohos.permission.MICROPHONE']);
      return result.authResults.length === 1 &&
        result.authResults[0] === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
    } catch {
      return false;
    }
  }
}
