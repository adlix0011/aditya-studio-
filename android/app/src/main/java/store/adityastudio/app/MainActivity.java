package store.adityastudio.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Sets up the delivery-alert channel before JavaScript starts. This lets FCM show
 * high-priority alerts while the WebView is in the background or the phone is locked.
 */
public class MainActivity extends BridgeActivity {
    private static final String DELIVERY_CHANNEL_ID = "delivery_orders";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4107;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createDeliveryAlertChannel();
        requestNotificationPermission();
    }

    private void createDeliveryAlertChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationChannel channel = new NotificationChannel(
                DELIVERY_CHANNEL_ID,
                "Delivery alerts",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("New orders and customer messages for Delivery Boy");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 250, 120, 300});
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                NOTIFICATION_PERMISSION_REQUEST
        );
    }
}
