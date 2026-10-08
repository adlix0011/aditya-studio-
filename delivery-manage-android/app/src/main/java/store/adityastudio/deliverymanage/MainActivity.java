package store.adityastudio.deliverymanage;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.media.AudioAttributes;
import android.graphics.Color;
import android.media.RingtoneManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String DELIVERY_CHANNEL_ID = "delivery_urgent_v2";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeliveryPermissionsPlugin.class);
        super.onCreate(savedInstanceState);
        createDeliveryAlertChannel();
    }

    private void createDeliveryAlertChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                DELIVERY_CHANNEL_ID,
                "Delivery alerts",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("New delivery orders and customer messages");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 300, 140, 350});
        channel.enableLights(true);
        channel.setLightColor(Color.CYAN);
        channel.setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
        );
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

}
