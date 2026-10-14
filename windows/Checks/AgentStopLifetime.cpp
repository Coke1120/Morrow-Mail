// Portable fixture for exact production agentStop/agentMutation/refreshAgent bodies, injected by
// scripts/test-agent-stop-lifetime.py. All request/UI operations below are fakes.
#include <cassert>
#include <coroutine>
#include <exception>
#include <iostream>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using hstring = std::wstring;
struct Json {
    hstring conversation, status = L"idle";
    hstring Stringify() const { return conversation + L":" + status; }
};
void put(Json& value, wchar_t const*, hstring const& id) { value.conversation = id; }
hstring text(Json const& value, wchar_t const* key) { return hstring(key) == L"status" ? value.status : value.conversation; }
hstring escaped(hstring const& value) { return value; }
struct hresult_error : std::exception { hstring message() const { return L"fixture request interrupted"; } };
struct fire_and_forget {
    struct promise_type {
        fire_and_forget get_return_object() { return {}; }
        std::suspend_never initial_suspend() noexcept { return {}; }
        std::suspend_never final_suspend() noexcept { return {}; }
        void return_void() noexcept {}
        void unhandled_exception() { std::terminate(); }
    };
};
using IAsyncAction = fire_and_forget;
struct Request { hstring path, owner, method, id; };
struct RequestState {
    std::coroutine_handle<> suspended;
    hstring path, owner, id;
    unsigned calls = 0;
    bool fail = false;
    hstring status = L"idle";
    std::vector<Request> requests;
    void finish() { auto next = std::exchange(suspended, {}); assert(next); next.resume(); }
};
struct Service {
    std::shared_ptr<RequestState> state;
    struct Pending {
        std::shared_ptr<RequestState> state;
        bool await_ready() const noexcept { return false; }
        void await_suspend(std::coroutine_handle<> frame) const { assert(!state->suspended); state->suspended = frame; }
        Json await_resume() const { if (state->fail) throw hresult_error(); return {state->id, state->status}; }
    };
    Pending request(hstring path, hstring owner, hstring method = L"GET", Json body = {}) {
        auto id = method == L"GET" ? path.substr(path.find_last_of(L'/') + 1) : body.conversation;
        state->requests.push_back({path, owner, method, id});
        ++state->calls; state->path = std::move(path); state->owner = std::move(owner); state->id = std::move(id);
        return {state};
    }
};
struct Shell {
    std::shared_ptr<Service> service;
    hstring agentConversation = L"conversation-A";
    std::set<std::wstring> dirty;
    unsigned applied = 0, rebuilt = 0;
    hstring lastError;
    void error(hstring const& value) { lastError = value; }
};
struct Intelligence {
    std::shared_ptr<Shell> shell;
    hstring owner = L"owner-A@fixture.invalid", notice;
    bool live = true, busy = false, cancelling = false, agentRecovering = false, polling = false;
    Json workflow;
    unsigned revision = 0;
    bool current() const { return live; }
    hstring key() const { return L"fixture-page"; }
    void dirty() { if (busy || cancelling) shell->dirty.insert(key()); else shell->dirty.erase(key()); }
    void tell(hstring const& message) { notice = message; }
    void stop() { live = false; ++revision; }
};
using Page = std::shared_ptr<Intelligence>;
void agentReload(Page const& page, Json const& result, hstring const& expected) {
    assert(result.conversation == expected && page->shell->agentConversation == expected);
    assert(page->owner == page->shell->service->state->owner);
    page->workflow = result;
    ++page->shell->applied;
}
std::suspend_never intelligencePage(std::shared_ptr<Shell> shell, hstring kind) {
    assert(kind == L"agent"); ++shell->rebuilt; return {};
}

// PRODUCTION_AGENT_STOP
// PRODUCTION_AGENT_MUTATION
// PRODUCTION_AGENT_REFRESH

struct Fixture {
    std::shared_ptr<RequestState> request = std::make_shared<RequestState>();
    std::shared_ptr<Shell> shell = std::make_shared<Shell>();
    Page page = std::make_shared<Intelligence>();
    Fixture() { shell->service = std::make_shared<Service>(Service{request}); page->shell = shell; }
};

int main() {
    {
        Fixture fixture;
        fixture.page->busy = true; // A suspended model turn must not disable Stop.
        std::weak_ptr<Intelligence> weak = fixture.page;
        agentStop(fixture.page);
        assert(fixture.page->cancelling && fixture.page->revision == 1 && fixture.request->calls == 1);
        agentStop(fixture.page); // Duplicate click must not start another cancellation.
        assert(fixture.request->calls == 1);
        fixture.page.reset();
        assert(!weak.expired()); // Only the coroutine frame now owns the page.
        fixture.request->finish();
        assert(weak.expired());
        assert(fixture.request->owner == L"owner-A@fixture.invalid" && fixture.request->id == L"conversation-A");
        assert(fixture.shell->applied == 1 && fixture.shell->rebuilt == 1);
    }
    {
        Fixture fixture;
        agentStop(fixture.page);
        fixture.page->live = false; // Account/page navigation while request waits.
        fixture.shell->agentConversation = L"conversation-B";
        fixture.request->finish();
        assert(fixture.shell->applied == 0 && fixture.shell->rebuilt == 0);
        assert(!fixture.page->cancelling && fixture.shell->dirty.empty());
        assert(fixture.request->owner == L"owner-A@fixture.invalid" && fixture.request->id == L"conversation-A");
    }
    {
        Fixture fixture;
        fixture.request->fail = true;
        agentStop(fixture.page);
        fixture.request->finish();
        assert(fixture.page->agentRecovering && !fixture.page->cancelling);
        assert(!fixture.page->notice.empty() && fixture.shell->applied == 0 && fixture.shell->rebuilt == 0);
        assert(fixture.request->calls == 1); // Recovery never retries a mutation.
    }
    {
        Fixture fixture;
        fixture.page->busy = true;
        agentStop(fixture.page);
        fixture.page->live = false;
        fixture.request->finish();
        // The still-running perform frame retains its own write/dirty guard.
        assert(!fixture.page->cancelling && fixture.shell->dirty.contains(fixture.page->key()));
    }
    {
        Fixture fixture;
        fixture.request->fail = true;
        agentMutation(fixture.page, L"/agent/send", {L"conversation-A"});
        fixture.request->finish(); // Interrupted POST triggers a read, never a replay.
        assert(fixture.request->calls == 2 && fixture.page->agentRecovering);
        assert(fixture.request->requests[0].path == L"/agent/send" && fixture.request->requests[0].method == L"POST");
        auto const& recovery = fixture.request->requests[1];
        assert(recovery.path == L"/agent/conversations/conversation-A" && recovery.method == L"GET" && recovery.owner == L"owner-A@fixture.invalid");
        fixture.request->fail = false; fixture.request->status = L"running";
        fixture.request->finish();
        assert(fixture.shell->applied == 1 && fixture.shell->rebuilt == 1 && !fixture.page->agentRecovering);
        assert(!fixture.shell->lastError.empty());
    }
    {
        Fixture fixture;
        fixture.request->fail = true;
        agentMutation(fixture.page, L"/agent/answer", {L"conversation-A"});
        fixture.request->finish(); fixture.request->finish(); // POST and immediate status read both fail.
        assert(fixture.page->agentRecovering && fixture.shell->rebuilt == 0 && fixture.request->calls == 2);
        fixture.request->fail = false;
        refreshAgent(fixture.page); // Next timer tick only reads the persisted conversation.
        assert(fixture.request->requests.back().method == L"GET");
        fixture.request->finish();
        assert(!fixture.page->agentRecovering && !fixture.page->polling && fixture.shell->rebuilt == 1);
        assert(fixture.request->calls == 3);
    }
    {
        Fixture fixture;
        agentMutation(fixture.page, L"/agent/send", {L"conversation-A"});
        ++fixture.page->revision; // A newer Stop or navigation invalidates the original turn.
        fixture.request->finish();
        assert(fixture.shell->applied == 0 && fixture.shell->rebuilt == 0 && fixture.request->calls == 1);
    }
    {
        Fixture fixture;
        fixture.page->workflow.status = L"running";
        refreshAgent(fixture.page);
        ++fixture.page->revision; // The old poll cannot overwrite a newer action.
        fixture.request->finish();
        assert(fixture.shell->applied == 0 && fixture.shell->rebuilt == 0 && !fixture.page->polling);
    }
    std::cout << "Production Stop/recovery coroutines: suspended lifetime, Stop while busy, duplicate click, captured owner/id, stale responses, GET-only timeout recovery and polling passed under ASan.\n";
}
