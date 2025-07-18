from PyQt5.QtWidgets import QWidget, QHBoxLayout, QMenuBar, QDialog, QMessageBox
from PyQt5.QtCore import Qt, QEvent
from app.settings import settings_manager
from .graph import TreeGraphWidget
from .console import CommandWidget
from ..utils import set_app_state
from ..settings_window import SettingsDialog
from ..controls import cleanup_history_signal
import logging

logger = logging.getLogger(__name__)

class MainWindow(QWidget):
    """
    combines TreeGraphWidget and CommandWidget together
    provides a menu bar
    """
    def __init__(self, work_tree):
        super().__init__()
        self.setWindowTitle("worktree")

        self.tree_graph_widget = TreeGraphWidget(work_tree)
        self.command_widget = CommandWidget(work_tree)
        self.main_layout = QHBoxLayout()
        self.main_layout.addWidget(self.tree_graph_widget, stretch=2)
        self.main_layout.addWidget(self.command_widget, stretch=3)
        self.main_layout.setContentsMargins(5,5,5,5)
        self.main_layout.setSpacing(5)

        self.menu_bar = QMenuBar()
        self.settings_menu = self.menu_bar.addMenu("Settings")
        self.settings_menu.addAction("Open settings window", self.open_settings_window)
        self.settings_menu.addAction("Recover to default settings", settings_manager.recover_default)
        self.storage_menu = self.menu_bar.addMenu("Storage")
        self.storage_menu.addAction("Cleanup history", self.cleanup_history)

        self.main_layout.setMenuBar(self.menu_bar)

        self.setLayout(self.main_layout)
        self.setGeometry(300, 300, 500, 300)

        self.installEventFilter(self)

    def to_frontground(self):
        self.show()
        self.raise_()
        self.activateWindow()
        self.command_widget.command_input.setFocus()
        # set_app_state(True)
        self.setWindowState(self.windowState() & ~Qt.WindowMinimized | Qt.WindowActive)

    def to_background(self):
        self.hide()
        # only one window here, so directly change the application policy
        # set_app_state(False)

    def toggle_state(self):
        if self.isVisible():
            logger.info("Hide window.")
            self.to_background()
        else:
            logger.info("Show window.")
            self.to_frontground()

    def closeEvent(self, event):
        self.to_background()
        event.ignore()
    
    def eventFilter(self, obj, event):
        if event.type() == QEvent.KeyPress:
            if event.key() == Qt.Key_Enter or event.key() == Qt.Key_Return:
                if not self.command_widget.command_input.hasFocus():
                    self.command_widget.command_input.setFocus()
                    return True
        return super().eventFilter(obj, event)
    
    def open_settings_window(self):
        dialog = SettingsDialog(self)
        dialog.exec_()
    
    def cleanup_history(self):
        result = QMessageBox.warning(
            self,
            "Confirm Cleanup History",
            "Sure to clean up all the history? This operation is irreversible.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if result == QMessageBox.Yes:
            cleanup_history_signal.emit()
            QMessageBox.information(
                self,
                "Cleanup History",
                "History has been cleaned up successfully.",
                QMessageBox.Ok,
            )
            
