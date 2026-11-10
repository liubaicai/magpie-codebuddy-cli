package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Copy into Magpie v0.1.3492 internal/gateway to probe the real holdWriter.
// An empty delta is the control; neither case relies on trusted thinking.
func TestCodeBuddyWhitespaceReleasesFreshThinkingHold(t *testing.T) {
	event := func(name, data string) string {
		return "event: " + name + "\ndata: " + data + "\n\n"
	}
	for _, tc := range []struct {
		name     string
		textJSON string
		releases bool
	}{
		{"empty_text_delta_stays_held", `""`, false},
		{"ascii_space_text_delta_releases", `" "`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h := newHoldWriter(rec, true)
			h.thinkingShown = false
			h.Header().Set("Content-Type", "text/event-stream")
			h.WriteHeader(http.StatusOK)
			if !h.hold || h.thinkingShown || h.passing || !h.mayAskAgain() {
				t.Fatal("probe must begin with a fresh, untrusted thinking hold")
			}
			var sent string
			write := func(name, data string) {
				t.Helper()
				ev := event(name, data)
				if n, err := h.Write([]byte(ev)); err != nil || n != len(ev) {
					t.Fatalf("write %s: n=%d err=%v", name, n, err)
				}
				h.Flush()
				sent += ev
			}
			check := func(passing bool) {
				t.Helper()
				if h.passing != passing || h.mayAskAgain() == passing {
					t.Fatalf("passing=%v mayAskAgain=%v; want passing=%v", h.passing, h.mayAskAgain(), passing)
				}
				want := ""
				if passing {
					want = sent
				}
				if got := rec.Body.String(); got != want {
					t.Fatalf("downstream event order/content mismatch:\n got %q\nwant %q", got, want)
				}
				if rec.Flushed != passing || !h.hold || h.thinkingShown {
					t.Fatalf("flushed=%v hold=%v thinkingShown=%v", rec.Flushed, h.hold, h.thinkingShown)
				}
			}

			write("message_start", `{"type":"message_start","message":{"id":"probe","role":"assistant","model":"deepseek-v4.1","content":[]}}`)
			write("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
			check(false)
			write("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":`+tc.textJSON+`}}`)
			check(tc.releases)
			write("content_block_stop", `{"type":"content_block_stop","index":0}`)
			check(tc.releases)
			write("content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}`)
			write("content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"fresh first thought"}}`)
			check(tc.releases)
			if !tc.releases && !h.thinking {
				t.Fatal("empty marker control did not exercise the untrusted-thinking hold")
			}
			if h.ended {
				t.Fatal("thinking observation must precede turn completion")
			}

			write("content_block_stop", `{"type":"content_block_stop","index":1}`)
			write("content_block_start", `{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}`)
			check(tc.releases)
			write("content_block_delta", `{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"actual answer"}}`)
			check(true)
			write("content_block_stop", `{"type":"content_block_stop","index":2}`)
			write("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`)
			write("message_stop", `{"type":"message_stop"}`)
			check(true)
			if !h.ended {
				t.Fatal("message_stop did not complete the stream")
			}
		})
	}
}
