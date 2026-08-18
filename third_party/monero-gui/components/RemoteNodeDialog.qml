// Copyright (c) 2021-2024, The Monero Project
//
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without modification, are
// permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this list of
//    conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice, this list
//    of conditions and the following disclaimer in the documentation and/or other
//    materials provided with the distribution.
//
// 3. Neither the name of the copyright holder nor the names of its contributors may be
//    used to endorse or promote products derived from this software without specific
//    prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL
// THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
// STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
// THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

import QtQuick 2.9
import QtQuick.Controls 2.2
import QtQuick.Layouts 1.1

import "." as MoneroComponents

MoneroComponents.Dialog {
    id: root
    title: (editMode ? qsTr("Edit remote node") : qsTr("Add remote node")) + translationManager.emptyString

    property var callbackOnSuccess: null
    property bool editMode: false
    property bool success: false

    onActiveFocusChanged: activeFocus && remoteNodeAddress.forceActiveFocus()

    function onOk() {
        root.success = true;
        root.close();
    }

    function onCancel() { root.close(); }

    function parseHostPort(address) {
        const text = (address || "").trim();
        const separator = text.lastIndexOf(":");
        if (separator <= 0 || separator === text.length - 1) {
            return ["", text, ""];
        }
        return ["", text.substring(0, separator), text.substring(separator + 1)];
    }

    function defaultGrpcPort(rpcPort) {
        if (rpcPort === "18089") return "18091";
        if (rpcPort === "28089") return "28091";
        if (rpcPort === "38089") return "38091";
        return "";
    }

    function isTex8CuprateHost(host) {
        return host === "152.53.133.188" || host === "private-node-ip" || host === "tex8.com";
    }

    function fillGrpcFromRemoteNode() {
        if (grpcNodeAddress.daemonAddrText === "")
            grpcNodeAddress.daemonAddrText = remoteNodeAddress.daemonAddrText === "tex8.com" ? "152.53.133.188" : remoteNodeAddress.daemonAddrText;
        if (grpcNodeAddress.daemonPortText === "")
            grpcNodeAddress.daemonPortText = defaultGrpcPort(remoteNodeAddress.daemonPortText);
    }

    function add(callbackOnSuccess) {
        root.editMode = false;
        root.callbackOnSuccess = callbackOnSuccess;

        open();
    }

    function edit(remoteNode, callbackOnSuccess) {
        const hostPort = parseHostPort(remoteNode.address);
        remoteNodeAddress.daemonAddrText = hostPort[1];
        remoteNodeAddress.daemonPortText = hostPort[2];

        const inferredGrpc = remoteNode.grpcAddress || (isTex8CuprateHost(hostPort[1]) && defaultGrpcPort(hostPort[2]) !== ""
            ? (hostPort[1] === "tex8.com" ? "152.53.133.188" : hostPort[1]) + ":" + defaultGrpcPort(hostPort[2])
            : "");
        const grpcHostPort = parseHostPort(inferredGrpc);
        grpcStreamCheckBox.checked = inferredGrpc !== "";
        grpcNodeAddress.daemonAddrText = grpcHostPort[1];
        grpcNodeAddress.daemonPortText = grpcHostPort[2];

        daemonUsername.text = remoteNode.username;
        daemonPassword.text = remoteNode.password;
        setTrustedDaemonCheckBox.checked = remoteNode.trusted;
        root.callbackOnSuccess = callbackOnSuccess;
        root.editMode = true;

        open();
    }

    onClosed: {
        if (root.success && callbackOnSuccess) {
            callbackOnSuccess({
                address: remoteNodeAddress.getAddress(),
                grpcAddress: grpcStreamCheckBox.checked ? grpcNodeAddress.getAddress() : "",
                username: daemonUsername.text,
                password: daemonPassword.text,
                trusted: setTrustedDaemonCheckBox.checked,
            });
        }

        remoteNodeAddress.daemonAddrText = "";
        remoteNodeAddress.daemonPortText = "";
        grpcStreamCheckBox.checked = false;
        grpcNodeAddress.daemonAddrText = "";
        grpcNodeAddress.daemonPortText = "";
        daemonUsername.text = "";
        daemonPassword.text = "";
        setTrustedDaemonCheckBox.checked = false;
        root.success = false;
    }

    MoneroComponents.RemoteNodeEdit {
        id: remoteNodeAddress
        Layout.fillWidth: true
        placeholderFontSize: 15

        daemonAddrLabelText: qsTr("Address") + translationManager.emptyString
        daemonPortLabelText: qsTr("Port") + translationManager.emptyString

        Keys.enabled: root.visible
        Keys.onEnterPressed: root.onOk()
        Keys.onReturnPressed: root.onOk()
        Keys.onEscapePressed: root.onCancel()
    }

    MoneroComponents.CheckBox {
        id: grpcStreamCheckBox
        activeFocusOnTab: true
        text: qsTr("Use Cuprate gRPC streaming sync") + translationManager.emptyString
        tooltip: qsTr("Optional. Use a Cuprate gRPC endpoint for faster block streaming while this remote node remains the normal wallet RPC endpoint.") + translationManager.emptyString

        onClicked: {
            if (checked) {
                root.fillGrpcFromRemoteNode();
            }
        }
    }

    MoneroComponents.RemoteNodeEdit {
        id: grpcNodeAddress
        Layout.fillWidth: true
        placeholderFontSize: 15
        visible: grpcStreamCheckBox.checked

        daemonAddrLabelText: qsTr("gRPC address") + translationManager.emptyString
        daemonPortLabelText: qsTr("gRPC port") + translationManager.emptyString
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 32

        MoneroComponents.LineEdit {
            id: daemonUsername
            Layout.fillWidth: true
            Layout.minimumWidth: 220
            labelText: qsTr("Daemon username") + translationManager.emptyString
            placeholderText: qsTr("(optional)") + translationManager.emptyString
            placeholderFontSize: 15
            labelFontSize: 14
            fontSize: 15
        }

        MoneroComponents.LineEdit {
            id: daemonPassword
            Layout.fillWidth: true
            Layout.minimumWidth: 220
            labelText: qsTr("Daemon password") + translationManager.emptyString
            placeholderText: qsTr("Password") + translationManager.emptyString
            password: true
            placeholderFontSize: 15
            labelFontSize: 14
            fontSize: 15

            Keys.enabled: root.visible
            Keys.onEnterPressed: root.onOk()
            Keys.onReturnPressed: root.onOk()
            Keys.onEscapePressed: root.onCancel()
        }
    }

    MoneroComponents.CheckBox {
        id: setTrustedDaemonCheckBox
        activeFocusOnTab: true
        text: qsTr("Mark as Trusted Daemon") + translationManager.emptyString
    }

    RowLayout {
        Layout.alignment: Qt.AlignRight
        spacing: parent.spacing

        MoneroComponents.StandardButton {
            activeFocusOnTab: true
            fontBold: false
            primary: false
            text: qsTr("Cancel")  + translationManager.emptyString

            onClicked: root.close()
        }

        MoneroComponents.StandardButton {
            activeFocusOnTab: true
            fontBold: false
            enabled: remoteNodeAddress.getAddress() != "" && (!grpcStreamCheckBox.checked || grpcNodeAddress.getAddress() != "")
            text: qsTr("Ok") + translationManager.emptyString

            onClicked: {
                root.success = true;
                root.close();
            }
        }
    }
}
