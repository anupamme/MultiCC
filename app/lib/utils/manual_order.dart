// 用户拖拽出来的手动顺序，如何叠加到默认顺序之上。
//
// 这是与 web 共享的一份语义（对照 public/ui-layout-store.js 的 applyOrder /
// reorderAround）：同一份服务端 ui-layout.json 被两个客户端读，两边算出来的列表
// 必须一模一样，否则「在手机上排好、换电脑打开变了样」——那正是把顺序搬上服务端
// 要解决的问题。所以两边的规则一字不差：
//
//   1. 排过的按用户给的次序在前；
//   2. 没排过的（多半是上次拖拽之后才新建的）保持调用方的默认顺序，缀在后面；
//   3. commander 钉首是**另外一趟**（见 pinCommanderFirst），不掺进比较器。
//
// 与 web 唯一的实现差异：JS 的 Array.prototype.sort 自 ES2019 起保证稳定，
// Dart 的 [List.sort] 不保证。所以这里不排序，直接用「分桶后拼接」——不依赖稳定性
// 也就没有「某次轮询把并列项换了位」的隐患。

/// 把 [items] 按 [order] 给出的手动顺序重排；[keyOf] 取 id。
///
/// [order] 为空时原样返回（还没人拖过，默认顺序说了算）。不在 [order] 里的元素
/// 保持它们在 [items] 中的相对顺序，整体接在已排项之后。
List<T> applyManualOrder<T>(
  List<T> items,
  List<String> order,
  String Function(T) keyOf,
) {
  if (order.isEmpty) return List<T>.from(items);
  final rank = <String, int>{};
  for (var i = 0; i < order.length; i++) {
    rank.putIfAbsent(order[i], () => i);
  }
  // 已排项按 rank 落桶（同一 rank 不可能重复，rank 由 putIfAbsent 去重保证），
  // 未排项按原顺序进 tail。
  final ranked = <int, T>{};
  final tail = <T>[];
  for (final item in items) {
    final r = rank[keyOf(item)];
    if (r == null) {
      tail.add(item);
    } else {
      ranked[r] = item;
    }
  }
  final keys = ranked.keys.toList()..sort();
  return [for (final k in keys) ranked[k]!, ...tail];
}

/// 把 [draggedId] 移到 [targetId] 当前所在的位置，返回**完整**的新顺序。
///
/// 返回完整顺序而不是只报一个 id，是因为第一次拖拽时服务端还没有任何记录：只存
/// 「被拖的那张卡」会让它排第一、其余全部变成未排项挤在后面，用户看到的是整列
/// 洗牌而不是移动一张卡。把当前屏幕上看到的顺序整体固化下来，才只有「这次拖拽之后
/// 新建的会话」是未排项。
///
/// 向下拖时插到目标之后、向上拖时插到目标之前——这就是把卡片拖到它下面那张上时
/// 的直觉结果（早期 web 实现一律插在目标之前，相邻向下拖等于没动）。
List<String> reorderAround(
  List<String> visibleIds,
  String draggedId,
  String targetId,
) {
  final next = List<String>.from(visibleIds);
  final from = next.indexOf(draggedId);
  final to = next.indexOf(targetId);
  if (from == -1 || to == -1 || from == to) return next;
  next.removeAt(from);
  next.insert(next.indexOf(targetId) + (from < to ? 1 : 0), draggedId);
  return next;
}

/// 一个 fleet 只存**一份平铺**的顺序，覆盖它内部所有分组（chats / terminals /
/// 以后可能加的），所以在某一组里拖拽不能把别的组的排布抹掉。[stored] 是这个
/// fleet 原有的顺序，[groupOrder] 是被拖那一组的完整新顺序；不属于该组的 id 原样
/// 带过来。
///
/// 它们落在平铺列表的哪一段无所谓：[applyManualOrder] 是**按组**跑的，一个 rank
/// 只会和同组 id 的 rank 相比。把被拖的组放前面只是最省事的写法。
List<String> mergeGroupOrder(List<String> stored, List<String> groupOrder) {
  final inGroup = groupOrder.toSet();
  return [...groupOrder, ...stored.where((id) => !inGroup.contains(id))];
}

/// 把 `ReorderableListView` 的落点翻译成完整的新顺序。
///
/// `onReorder(oldIndex, newIndex)` 的 [newIndex] 是**移走之前**的插入位：向下
/// 拖时它比最终位置大 1（Flutter 文档里那句 `newIndex -= 1`）。[reorderAround]
/// 是按「目标项」定义的，所以这里先把偏移抹平，再交给同一套语义 —— 两端
/// （目录、会话）的规则因此不会分叉。
///
/// 越界、拖回原位（包括 `newIndex == oldIndex + 1` 这种相邻往下拖）原样返回；
/// 调用方据「有没有变」决定要不要发保存请求。
List<String> reorderIdsForDrop(
  List<String> visibleIds,
  int oldIndex,
  int newIndex,
) {
  if (oldIndex < 0 || oldIndex >= visibleIds.length) {
    return List<String>.from(visibleIds);
  }
  final targetIndex = newIndex > oldIndex ? newIndex - 1 : newIndex;
  if (targetIndex == oldIndex ||
      targetIndex < 0 ||
      targetIndex >= visibleIds.length) {
    return List<String>.from(visibleIds);
  }
  return reorderAround(
    visibleIds,
    visibleIds[oldIndex],
    visibleIds[targetIndex],
  );
}

/// 一次拖拽的乐观状态：屏幕先落到新顺序，保存失败时按 [drop] 给出的快照回滚。
///
/// 顺序只在用户拖过之后才变成「完整列表」—— 见 [reorderAround] 的注释：第一次
/// 拖拽要把当前看到的整列固化下来，否则未排过的项会全挤到后面。未拖过时
/// [order] 为空，调用方照旧用默认顺序。
class ManualOrderDraft {
  ManualOrderDraft([Iterable<String> order = const []])
    : _order = List<String>.from(order);

  List<String> _order;

  /// 当前的完整手动顺序；空 = 还没拖过（默认顺序说了算）。
  List<String> get order => List<String>.unmodifiable(_order);

  /// 把这次拖拽落成完整顺序，返回**回滚快照**。没有实际移动时返回 null。
  List<String>? drop(List<String> visibleIds, int oldIndex, int newIndex) {
    final next = reorderIdsForDrop(visibleIds, oldIndex, newIndex);
    if (_sameIds(next, visibleIds)) return null;
    final previous = List<String>.from(_order);
    _order = next;
    return previous;
  }

  /// 用加载到（或服务端定稿）的排布覆盖本地草稿。
  void replace(Iterable<String> order) {
    _order = List<String>.from(order);
  }

  /// 保存失败：回到 [drop] 返回的快照。
  void rollback(List<String> snapshot) {
    _order = List<String>.from(snapshot);
  }
}

bool _sameIds(List<String> left, List<String> right) {
  if (left.length != right.length) return false;
  for (var i = 0; i < left.length; i++) {
    if (left[i] != right[i]) return false;
  }
  return true;
}
