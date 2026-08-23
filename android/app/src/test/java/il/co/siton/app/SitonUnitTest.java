package il.co.siton.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SitonUnitTest {
    @Test
    public void releaseIdentityUsesExternalizableReverseDnsId() {
        String applicationId = BuildConfig.APPLICATION_ID;
        assertTrue(applicationId.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*){2,}"));
        assertFalse(applicationId.contains("getcapacitor"));
    }
}
