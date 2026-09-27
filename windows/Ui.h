#pragma once
#include "Service.h"
#include <winrt/Microsoft.UI.Xaml.h>
#include <winrt/Microsoft.UI.Xaml.Controls.h>
#include <winrt/Microsoft.UI.Xaml.Media.h>
#include <functional>
#include <set>

namespace morrow {
namespace xaml = winrt::Microsoft::UI::Xaml;
namespace controls = winrt::Microsoft::UI::Xaml::Controls;
controls::TextBlock label(winrt::hstring const& value, double size = 14);
controls::Button button(winrt::hstring const& value, std::function<void()> action);
controls::StackPanel stack(double gap = 8);
controls::TextBox field(winrt::hstring const& title, winrt::hstring const& value = {}, bool multiline = false);
controls::ScrollViewer scroll(xaml::UIElement const& child);

struct Shell : std::enable_shared_from_this<Shell> {
    xaml::Window window{nullptr};
    controls::Grid root{nullptr};
    controls::NavigationView navigation{nullptr};
    controls::ContentControl page{nullptr};
    controls::TextBlock status{nullptr};
    controls::ListView rows{nullptr};
    controls::ContentControl reader{nullptr};
    controls::Grid mailBody{nullptr};
    xaml::FrameworkElement mailDivider{nullptr};
    controls::TextBox search{nullptr};
    controls::ComboBox sorting{nullptr};
    controls::Button previous{nullptr}, next{nullptr};
    controls::TextBlock pageLabel{nullptr};
    xaml::DispatcherTimer timer{nullptr};
    std::shared_ptr<Service> service;
    Json state;
    Json selected;
    Json updateResult;
    winrt::hstring owner, folder = L"inbox", section = L"mail", nextCursor;
    winrt::hstring mailLayout = L"right";
    bool readerFocused = false;
    double listWidth = 400, listHeight = 300;
    std::vector<winrt::hstring> cursors{L""};
    uint64_t generation = 0, selectionGeneration = 0;
    bool loading = false, closing = false, dialogOpen = false, selectingNavigation = false;
    bool checkingUpdates = false, includePrereleases = true;
    uint64_t lastUpdateCheck = 0;
    std::set<std::wstring> dirty;
    winrt::Windows::Foundation::IAsyncAction start();
    winrt::Windows::Foundation::IAsyncAction refresh(bool rebuildNavigation = false);
    winrt::Windows::Foundation::IAsyncAction navigate(winrt::hstring target, winrt::hstring account = {}, winrt::hstring mailFolder = L"inbox");
    winrt::Windows::Foundation::IAsyncAction loadPage();
    winrt::Windows::Foundation::IAsyncAction read(Json metadata);
    winrt::Windows::Foundation::IAsyncAction patch(Json message, Json changes);
    winrt::Windows::Foundation::IAsyncAction prepare(Json message, winrt::hstring mode, winrt::hstring body = {});
    winrt::Windows::Foundation::IAsyncAction messageAI(Json message, winrt::hstring action, bool history = false);
    winrt::Windows::Foundation::IAsyncAction organize(Json message);
    winrt::Windows::Foundation::IAsyncAction sync();
    winrt::Windows::Foundation::IAsyncAction checkUpdates(bool force = false);
    void updateBadge();
    winrt::Windows::Foundation::IAsyncAction shutdown();
    winrt::Windows::Foundation::IAsyncOperation<bool> confirm(winrt::hstring title, winrt::hstring detail, winrt::hstring accept = L"Continue");
    winrt::Windows::Foundation::IAsyncAction alert(winrt::hstring title, winrt::hstring detail);
    winrt::Windows::Foundation::IAsyncAction smoke();
    bool current(uint64_t value, winrt::hstring const& account) const;
    bool connected(winrt::hstring const& account) const;
    void error(winrt::hstring const& message);
    void show(xaml::UIElement const& content);
    void rebuildNavigation();
    void mailPage();
    void applyMailLayout();
    void renderReader(Json const& message);
};
winrt::Windows::Foundation::IAsyncAction compose(std::shared_ptr<Shell> shell, Json draft = Json());
winrt::Windows::Foundation::IAsyncAction scheduledPage(std::shared_ptr<Shell> shell);
winrt::Windows::Foundation::IAsyncAction settingsPage(std::shared_ptr<Shell> shell, winrt::hstring tab = L"mail");
winrt::Windows::Foundation::IAsyncAction workspacePage(std::shared_ptr<Shell> shell, winrt::hstring kind);
void appendReader(std::shared_ptr<Shell> shell, controls::StackPanel const& container, Json message);
}
