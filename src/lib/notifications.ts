import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { ScheduledCall } from './scheduled-call';

export const SCHEDULED_CALL_CATEGORY = 'scheduled-call';
const SCHEDULED_CALL_CHANNEL = 'scheduled-calls-silent-v1';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function prepareNotifications() {
  if (Platform.OS === 'web') return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(SCHEDULED_CALL_CHANNEL, {
      name: 'Scheduled calls',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 350, 180, 350],
      lightColor: '#FF6242',
      sound: null,
    });
  }

  await Notifications.setNotificationCategoryAsync(SCHEDULED_CALL_CATEGORY, [
    {
      identifier: 'answer',
      buttonTitle: 'Answer',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'decline',
      buttonTitle: 'Decline',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);

  const current = await Notifications.getPermissionsAsync();
  const permission =
    current.status === 'granted'
      ? current
      : await Notifications.requestPermissionsAsync();

  return permission.status === 'granted';
}

export async function scheduleScheduledCallNotification(call: ScheduledCall) {
  if (Platform.OS === 'web') return null;
  if (new Date(call.scheduledFor).getTime() <= Date.now()) return null;

  const allowed = await prepareNotifications();
  if (!allowed) return null;

  return Notifications.scheduleNotificationAsync({
    content: {
      title: `${call.caller.name} is calling…`,
      body:
        call.kind === 'reminder'
          ? call.content.summary
          : `${call.caller.relationship} · ${call.title}`,
      sound: false,
      categoryIdentifier: SCHEDULED_CALL_CATEGORY,
      data: {
        type: 'scheduled-call',
        callId: call.id,
        kind: call.kind,
      },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(call.scheduledFor),
      channelId: SCHEDULED_CALL_CHANNEL,
    },
  });
}

export async function cancelScheduledCallNotification(notificationId: string | null) {
  if (Platform.OS === 'web' || !notificationId) return;
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}
