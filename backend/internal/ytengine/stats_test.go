package ytengine

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestChannelContextNormalization(t *testing.T) {
	if got := ChannelFromContext(nil); got != ChannelAnonymous {
		t.Fatalf("ChannelFromContext(nil) = %q, want %q", got, ChannelAnonymous)
	}
	if got := ChannelFromContext(context.Background()); got != ChannelAnonymous {
		t.Fatalf("ChannelFromContext(background) = %q, want %q", got, ChannelAnonymous)
	}
	for _, raw := range []string{"", "anonymous", "OWNER", "vip", "attacker-supplied"} {
		ctx := WithChannel(context.Background(), raw)
		if got := ChannelFromContext(ctx); got != ChannelAnonymous {
			t.Fatalf("WithChannel(%q) => %q, want %q", raw, got, ChannelAnonymous)
		}
	}
	ownerCtx := WithChannel(nil, ChannelOwner)
	if got := ChannelFromContext(ownerCtx); got != ChannelOwner {
		t.Fatalf("WithChannel(nil, owner) => %q, want %q", got, ChannelOwner)
	}
}

func TestSlotStatsUncontendedAndContendedPerChannel(t *testing.T) {
	gateDir := t.TempDir()
	script := `
target=""
for arg in "$@"; do
  target="$arg"
done
id="${target##*/}"
touch "` + gateDir + `/started_${id}"
while [ ! -f "` + gateDir + `/release_${id}" ]; do
  sleep 0.01
done
cat <<JSON
{"id":"${id}","_type":"video","title":"ok","formats":[{"format_id":"f1","url":"https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x720/a.mp4","ext":"mp4","protocol":"https"}]}
JSON
`
	binPath, hashes := writeFakeYTDLP(t, script)
	baseEng, err := New(Config{
		BinaryPath:     binPath,
		AllowedHashes:  hashes,
		MaxConcurrency: 1,
		Timeout:        5 * time.Second,
	})
	if err != nil {
		t.Fatalf("New engine failed: %v", err)
	}
	// Derive platform-scoped shallow copies to verify they share one semaphore and one *slotStats block.
	xEng := baseEng.WithTargetPolicy(func(string) bool { return true }, nil).WithExtractors("twitter")
	igEng := baseEng.WithTargetPolicy(func(string) bool { return true }, nil)

	release := func(id string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(gateDir, "release_"+id), []byte("1"), 0o600); err != nil {
			t.Fatalf("write release_%s: %v", id, err)
		}
	}
	waitStarted := func(id string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(gateDir, "started_"+id)); err == nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for subprocess %s to start", id)
	}
	waitGaugeWaiting := func(want int) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if snap := baseEng.StatsSnapshot(); snap.Waiting == want {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for Waiting=%d (got %+v)", want, baseEng.StatsSnapshot())
	}

	// 1. Uncontended calls for both channels must record 0 wait_count.
	release("uncontended_anon")
	if _, err := xEng.Extract(context.Background(), "https://x.com/i/status/uncontended_anon"); err != nil {
		t.Fatalf("uncontended anon Extract failed: %v", err)
	}
	release("uncontended_owner")
	ownerCtx := WithChannel(context.Background(), ChannelOwner)
	if _, err := igEng.Extract(ownerCtx, "https://x.com/i/status/uncontended_owner"); err != nil {
		t.Fatalf("uncontended owner Extract failed: %v", err)
	}

	snap0 := baseEng.StatsSnapshot()
	if !snap0.Enabled || snap0.ConcurrencyLimit != 1 || snap0.Active != 0 || snap0.Waiting != 0 {
		t.Fatalf("unexpected idle snapshot after uncontended calls: %+v", snap0)
	}
	if snap0.ByChannel.Anonymous.AcquiredCount != 1 || snap0.ByChannel.Anonymous.WaitCount != 0 || snap0.ByChannel.Anonymous.WaitMSTotal != 0 {
		t.Fatalf("uncontended anonymous call must have 0 waits: %+v", snap0.ByChannel.Anonymous)
	}
	if snap0.ByChannel.Owner.AcquiredCount != 1 || snap0.ByChannel.Owner.WaitCount != 0 || snap0.ByChannel.Owner.WaitMSTotal != 0 {
		t.Fatalf("uncontended owner call must have 0 waits: %+v", snap0.ByChannel.Owner)
	}

	// 2. Owner holds the single yt-dlp slot while one anonymous request waits for grant
	//    and another anonymous request cancels while waiting.
	ownerHoldDone := make(chan error, 1)
	go func() {
		_, err := xEng.Extract(ownerCtx, "https://x.com/i/status/owner_hold")
		ownerHoldDone <- err
	}()
	waitStarted("owner_hold")

	release("anon_waiter")
	anonWaitDone := make(chan error, 1)
	go func() {
		_, err := igEng.Extract(WithChannel(context.Background(), ChannelAnonymous), "https://x.com/i/status/anon_waiter")
		anonWaitDone <- err
	}()
	waitGaugeWaiting(1)

	cancelCtx, cancelFn := context.WithCancel(WithChannel(context.Background(), ChannelAnonymous))
	anonCancelDone := make(chan error, 1)
	go func() {
		_, err := xEng.Extract(cancelCtx, "https://x.com/i/status/anon_canceled")
		anonCancelDone <- err
	}()
	waitGaugeWaiting(2)

	liveSnap := igEng.StatsSnapshot()
	if liveSnap.Active != 1 || liveSnap.Waiting != 2 {
		t.Fatalf("expected live Active=1 Waiting=2, got %+v", liveSnap)
	}

	time.Sleep(25 * time.Millisecond)
	cancelFn()
	if err := <-anonCancelDone; err == nil {
		t.Fatal("expected canceled anonymous waiter to return error")
	}
	waitGaugeWaiting(1)

	time.Sleep(20 * time.Millisecond)
	release("owner_hold")
	if err := <-ownerHoldDone; err != nil {
		t.Fatalf("owner_hold Extract failed: %v", err)
	}
	if err := <-anonWaitDone; err != nil {
		t.Fatalf("anon_waiter Extract failed: %v", err)
	}

	snap1 := baseEng.StatsSnapshot()
	if snap1.ByChannel.Owner.WaitCount != 0 || snap1.ByChannel.Owner.AcquiredCount != 2 {
		t.Fatalf("owner should still have 0 waits and 2 acquisitions, got %+v", snap1.ByChannel.Owner)
	}
	if snap1.ByChannel.Anonymous.AcquiredCount != 2 ||
		snap1.ByChannel.Anonymous.CanceledCount != 1 ||
		snap1.ByChannel.Anonymous.WaitCount != 2 ||
		snap1.ByChannel.Anonymous.WaitMSTotal < 25 ||
		snap1.ByChannel.Anonymous.WaitMSMax < 20 {
		t.Fatalf("unexpected anonymous contention counters: %+v", snap1.ByChannel.Anonymous)
	}

	// 3. Flip roles: anonymous holds the single yt-dlp slot while owner waits.
	anonHoldDone := make(chan error, 1)
	go func() {
		_, err := xEng.Extract(context.Background(), "https://x.com/i/status/anon_hold")
		anonHoldDone <- err
	}()
	waitStarted("anon_hold")

	release("owner_waiter")
	ownerWaitDone := make(chan error, 1)
	go func() {
		_, err := igEng.Extract(ownerCtx, "https://x.com/i/status/owner_waiter")
		ownerWaitDone <- err
	}()
	waitGaugeWaiting(1)

	time.Sleep(35 * time.Millisecond)
	release("anon_hold")
	if err := <-anonHoldDone; err != nil {
		t.Fatalf("anon_hold Extract failed: %v", err)
	}
	if err := <-ownerWaitDone; err != nil {
		t.Fatalf("owner_waiter Extract failed: %v", err)
	}

	snap2 := baseEng.StatsSnapshot()
	if snap2.ByChannel.Owner.AcquiredCount != 3 ||
		snap2.ByChannel.Owner.WaitCount != 1 ||
		snap2.ByChannel.Owner.WaitMSTotal < 20 ||
		snap2.ByChannel.Owner.WaitMS.Count != 1 {
		t.Fatalf("expected owner WaitCount=1 and WaitMSTotal>=20, got %+v", snap2.ByChannel.Owner)
	}
	if snap2.Total.AcquiredCount != snap2.ByChannel.Anonymous.AcquiredCount+snap2.ByChannel.Owner.AcquiredCount ||
		snap2.Total.WaitCount != snap2.ByChannel.Anonymous.WaitCount+snap2.ByChannel.Owner.WaitCount ||
		snap2.Total.CanceledCount != snap2.ByChannel.Anonymous.CanceledCount+snap2.ByChannel.Owner.CanceledCount {
		t.Fatalf("total snapshot mismatch: total=%+v by_channel=%+v", snap2.Total, snap2.ByChannel)
	}
}
