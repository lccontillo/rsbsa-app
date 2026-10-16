import io
import json
import os
import unittest
from app import app
import db
import db_id

class TestRSBSAEnhancements(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
        cls.client = app.test_client()
        conn = db.connect()
        try:
            conn.execute("DELETE FROM messages WHERE sender_id IN (SELECT id FROM users WHERE username IN ('test_sec_temp', 'test_sec_user')) OR recipient_id IN (SELECT id FROM users WHERE username IN ('test_sec_temp', 'test_sec_user'))")
            conn.execute("DELETE FROM users WHERE username IN ('test_sec_temp', 'test_sec_user')")
            conn.execute("DELETE FROM farmers WHERE rsbsa_number IN ('02-015-02-001-999901', '02-015-02-001-999902')")
            conn.commit()
        finally:
            conn.close()
        conn_id = db_id.connect()
        try:
            conn_id.execute("DELETE FROM id_cards WHERE person_id IN (SELECT id FROM id_persons WHERE rsbsa_number IN ('02-015-02-001-999901', '02-015-02-001-999902'))")
            conn_id.execute("DELETE FROM id_persons WHERE rsbsa_number IN ('02-015-02-001-999901', '02-015-02-001-999902')")
            conn_id.commit()
        finally:
            conn_id.close()

    def login_admin(self):
        res = self.client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
        self.assertEqual(res.status_code, 200, res.data)
        return json.loads(res.data)

    def login_secretary(self, username="test_sec_user", password="sec_password_123"):
        res = self.client.post("/api/auth/login", json={"username": username, "password": password})
        self.assertEqual(res.status_code, 200, res.data)
        return json.loads(res.data)

    def test_01_office_info(self):
        res = self.client.get("/api/office-info")
        self.assertEqual(res.status_code, 200)
        data = json.loads(res.data)
        self.assertIn("municipality", data)
        self.assertIn("province", data)
        print("[PASS] test_01_office_info:", data)

    def test_02_password_change_and_first_login(self):
        # Admin creates a new secretary user with must_change_password=1
        self.login_admin()
        # Clean up if existed
        conn = db.connect()
        try:
            conn.execute("DELETE FROM messages WHERE sender_id IN (SELECT id FROM users WHERE username IN ('test_sec_temp', 'test_sec_user')) OR recipient_id IN (SELECT id FROM users WHERE username IN ('test_sec_temp', 'test_sec_user'))")
            conn.execute("DELETE FROM users WHERE username IN ('test_sec_temp', 'test_sec_user')")
            conn.commit()
        finally:
            conn.close()

        u_res = self.client.post("/api/admin/users", json={
            "full_name": "Test Sec",
            "username": "test_sec_temp",
            "password": "temp_password_123",
            "role": "secretary",
            "barangay_id": 1
        })
        self.assertEqual(u_res.status_code, 200)

        # Login as new secretary
        login_res = self.login_secretary("test_sec_temp", "temp_password_123")
        self.assertTrue(login_res["me"]["must_change_password"])

        # Secretary changes password
        ch_res = self.client.post("/api/auth/change-password", json={
            "current_password": "temp_password_123",
            "new_password": "new_secure_password_456"
        })
        self.assertEqual(ch_res.status_code, 200)

        # Login again with new password
        login2 = self.client.post("/api/auth/login", json={
            "username": "test_sec_temp",
            "password": "new_secure_password_456"
        })
        self.assertEqual(login2.status_code, 200)
        self.assertFalse(json.loads(login2.data)["me"]["must_change_password"])
        print("[PASS] test_02_password_change_and_first_login")

    def test_03_heartbeat_and_active_secretaries(self):
        self.login_secretary("test_sec_temp", "new_secure_password_456")
        hb_res = self.client.post("/api/heartbeat")
        self.assertEqual(hb_res.status_code, 200)

        # Admin checks active secretaries
        self.login_admin()
        act_res = self.client.get("/api/admin/active-secretaries")
        self.assertEqual(act_res.status_code, 200)
        secs = json.loads(act_res.data)["secretaries"]
        found = any(s["username"] == "test_sec_temp" and s["is_online"] for s in secs)
        self.assertTrue(found, "Newly active secretary should be online")
        print("[PASS] test_03_heartbeat_and_active_secretaries")

    def test_04_messaging_direct_and_group(self):
        # Admin sends direct message to test_sec_temp
        self.login_admin()
        secs = json.loads(self.client.get("/api/admin/active-secretaries").data)["secretaries"]
        sec_obj = next(s for s in secs if s["username"] == "test_sec_temp")
        
        send_res = self.client.post("/api/messages", json={
            "recipient_id": sec_obj["id"],
            "message": "Hello Secretary, please submit monthly report."
        })
        self.assertEqual(send_res.status_code, 200)

        # Admin sends group broadcast announcement
        bcast_res = self.client.post("/api/messages", json={
            "is_broadcast": True,
            "message": "Attention all staff: Office meeting at 2 PM today."
        })
        self.assertEqual(bcast_res.status_code, 200)

        # Secretary checks unread count and messages
        self.login_secretary("test_sec_temp", "new_secure_password_456")
        unr_res = self.client.get("/api/messages/unread-count")
        self.assertEqual(unr_res.status_code, 200)
        self.assertGreaterEqual(json.loads(unr_res.data)["unread"], 2)

        msg_res = self.client.get("/api/messages")
        self.assertEqual(msg_res.status_code, 200)
        msgs = json.loads(msg_res.data)["messages"]
        self.assertGreaterEqual(len(msgs), 2)

        # Mark read
        mark_res = self.client.post("/api/messages/mark-read", json={"message_ids": [m["id"] for m in msgs]})
        self.assertEqual(mark_res.status_code, 200)
        self.assertEqual(json.loads(self.client.get("/api/messages/unread-count").data)["unread"], 0)

        # Secretary replies back to admin
        rep_res = self.client.post("/api/messages", json={"message": "Noted Admin, report is ready."})
        self.assertEqual(rep_res.status_code, 200)
        print("[PASS] test_04_messaging_direct_and_group")

    def test_05_update_databases_csv_upload_and_verification(self):
        self.login_admin()
        csv_content = """RSBSA Number,Farmer Name,Gender,Civil Status,Address,Barangay,Remarks,Birthdate,Contact Number,Emergency Contact,Affiliated FCA
02-015-02-001-999901,FERNANDO POE JR,MALE,MARRIED,ZONE 1,POBLACION,Active,1980-05-15,09171234567,SUSAN ROCES - 09171234568,POBLACION FARMERS ASSOC
02-015-02-001-999902,NORA AUNOR,FEMALE,WIDOWED,ZONE 2,POBLACION,Bedridden,1982-08-20,09181234567,IAN DE LEON - 09181234568,ALCALA CORN GROWERS
"""
        data = {
            'file': (io.BytesIO(csv_content.encode('utf-8')), 'test_farmers.csv')
        }
        res = self.client.post('/api/id-generator/import-csv', data=data, content_type='multipart/form-data')
        self.assertEqual(res.status_code, 200, res.data)
        rj = json.loads(res.data)
        self.assertTrue(rj["ok"])

        # Check in Farmer Masterlist - status MUST be 'verified'
        f_res = self.client.get("/api/farmers?q=FERNANDO")
        self.assertEqual(f_res.status_code, 200)
        farmers = json.loads(f_res.data)
        self.assertTrue(len(farmers) >= 1)
        f_record = farmers[0]
        self.assertEqual(f_record["verification_status"], "verified")
        self.assertEqual(f_record["remarks"], "Active")

        # Test deduplication on re-upload
        data2 = {
            'file': (io.BytesIO(csv_content.encode('utf-8')), 'test_farmers_dup.csv')
        }
        res2 = self.client.post('/api/id-generator/import-csv', data=data2, content_type='multipart/form-data')
        self.assertEqual(res2.status_code, 200)
        rj2 = json.loads(res2.data)
        self.assertEqual(rj2["added"], 0)
        self.assertEqual(rj2["duplicates"], 2)
        print("[PASS] test_05_update_databases_csv_upload_and_verification")

    def test_06_remarks_workflow_and_delete_permissions(self):
        self.login_admin()
        farmers = json.loads(self.client.get("/api/farmers?q=FERNANDO").data)
        fid = farmers[0]["id"]

        # Secretary tries to edit remarks -> routed to pending approval
        self.login_secretary("test_sec_temp", "new_secure_password_456")
        rem_res = self.client.post(f"/api/farmers/{fid}/remarks", json={"remarks": "OFW"})
        self.assertEqual(rem_res.status_code, 200)

        # Secretary cannot delete verified farmer
        sec_del = self.client.delete(f"/api/farmers/{fid}")
        self.assertIn(sec_del.status_code, (401, 403))

        # Check farmer record has pending_remarks
        f_check = json.loads(self.client.get(f"/api/farmers/{fid}").data)
        self.assertEqual(f_check["pending_remarks"], "OFW")
        self.assertEqual(f_check["remarks"], "Active")  # Still Active until admin approval!

        # Admin approves remarks change
        self.login_admin()
        app_res = self.client.post(f"/api/farmers/{fid}/remarks/approve")
        self.assertEqual(app_res.status_code, 200)

        # Verify remarks is now OFW and pending is cleared
        f_approved = json.loads(self.client.get(f"/api/farmers/{fid}").data)
        self.assertEqual(f_approved["remarks"], "OFW")
        self.assertIsNone(f_approved["pending_remarks"])

        # Admin deletes verified farmer
        adm_del = self.client.delete(f"/api/farmers/{fid}")
        self.assertEqual(adm_del.status_code, 200)
        print("[PASS] test_06_remarks_workflow_and_delete_permissions")

    def test_07_id_generation_batch_print_and_tag(self):
        self.login_admin()
        # Find Nora Aunor in ID persons
        id_persons = json.loads(self.client.get("/api/id-generator/persons?q=NORA").data)["persons"]
        self.assertTrue(len(id_persons) >= 1)
        pid = id_persons[0]["id"]

        # Generate ID card
        gen_res = self.client.post(f"/api/id-generator/persons/{pid}/id-card", json={"valid_years": 3})
        self.assertEqual(gen_res.status_code, 200)
        card_info = json.loads(gen_res.data)
        self.assertIn("control_no", card_info)

        # Batch print A4
        batch_res = self.client.post("/api/id-generator/batch-print", json={"person_ids": [pid]})
        self.assertEqual(batch_res.status_code, 200)
        self.assertEqual(batch_res.mimetype, "application/pdf")
        self.assertGreater(len(batch_res.data), 1000)

        # Verify card is now tagged printed
        p_check = json.loads(self.client.get(f"/api/id-generator/persons/{pid}").data)
        self.assertEqual(p_check["is_printed"], 1)

        # Untag printed
        untag_res = self.client.post(f"/api/id-generator/cards/{pid}/tag-printed", json={"is_printed": False})
        self.assertEqual(untag_res.status_code, 200)
        p_check2 = json.loads(self.client.get(f"/api/id-generator/persons/{pid}").data)
        self.assertEqual(p_check2["is_printed"], 0)
        print("[PASS] test_07_id_generation_batch_print_and_tag")

    def test_08_reports_farmer_ids(self):
        self.login_admin()
        # JSON report
        rep_res = self.client.get("/api/reports/farmer-ids")
        self.assertEqual(rep_res.status_code, 200)
        data = json.loads(rep_res.data)
        self.assertIn("total_issued", data)
        self.assertIn("by_barangay", data)
        self.assertIn("by_fca", data)
        self.assertIn("rows", data)

        # PDF report
        pdf_res = self.client.get("/api/reports/farmer-ids/pdf")
        self.assertEqual(pdf_res.status_code, 200)
        self.assertEqual(pdf_res.mimetype, "application/pdf")
        self.assertGreater(len(pdf_res.data), 1000)

        # CSV report
        csv_res = self.client.get("/api/reports/farmer-ids/csv")
        self.assertEqual(csv_res.status_code, 200)
        self.assertEqual(csv_res.mimetype, "text/csv")
        self.assertIn("Control No", csv_res.data.decode("utf-8"))
        print("[PASS] test_08_reports_farmer_ids")

    def test_09_archive_filters_preview_and_regeneration(self):
        self.login_admin()
        certs_res = self.client.get("/api/certificates")
        self.assertEqual(certs_res.status_code, 200)
        certs = json.loads(certs_res.data)
        if certs:
            cid = certs[0]["id"]
            # Preview endpoint
            prev_res = self.client.get(f"/api/certificates/{cid}/preview")
            self.assertEqual(prev_res.status_code, 200)
            self.assertEqual(prev_res.mimetype, "application/pdf")

            # Regeneration endpoint
            regen_res = self.client.post(f"/api/certificates/{cid}/regenerate", json={})
            self.assertEqual(regen_res.status_code, 200)
            rj = json.loads(regen_res.data)
            self.assertTrue(rj["ok"])
        print("[PASS] test_09_archive_filters_preview_and_regeneration")

    def test_10_dynamic_schema_builder_and_presets(self):
        self.login_admin()
        tpls = json.loads(self.client.get("/api/admin/templates").data)
        self.assertTrue(len(tpls) >= 1)
        tid = tpls[0]["id"]

        # Test detect-docx endpoint
        det_res = self.client.post(f"/api/admin/templates/{tid}/detect-docx")
        self.assertEqual(det_res.status_code, 200)
        detected = json.loads(det_res.data)["fields"]
        self.assertIsInstance(detected, list)

        # Update schema with custom dynamic controls, presets & dropdown options
        schema_update = [
            {
                "key": "CROP_COMMODITY",
                "label": "Crop Commodity (Pananim)",
                "type": "select",
                "options": ["Rice/Palay", "Corn", "High-value crops", "Tobacco"],
                "required": True,
                "system": False,
                "placeholder": "",
                "default_value": "Rice/Palay",
                "help": "Select crop commodity for certification"
            },
            {
                "key": "FARM_AREA",
                "label": "Farm Area (Hectares)",
                "type": "number",
                "options": [],
                "required": True,
                "system": False,
                "placeholder": "e.g. 1.25",
                "default_value": "1.00",
                "help": "Cultivated area"
            },
            {
                "key": "CERT_NO",
                "label": "Certificate Number",
                "type": "text",
                "options": [],
                "required": False,
                "system": True,
                "placeholder": "",
                "default_value": "",
                "help": "Auto-filled"
            }
        ]
        up_res = self.client.patch(f"/api/admin/templates/{tid}", json={"fields": schema_update})
        self.assertEqual(up_res.status_code, 200)

        # Verify updated template
        tpls_updated = json.loads(self.client.get("/api/admin/templates").data)
        t_mod = next(t for t in tpls_updated if t["id"] == tid)
        crop_field = next(f for f in t_mod["fields"] if f["key"] == "CROP_COMMODITY")
        self.assertEqual(crop_field["type"], "select")
        self.assertEqual(crop_field["options"], ["Rice/Palay", "Corn", "High-value crops", "Tobacco"])
        self.assertEqual(crop_field["default_value"], "Rice/Palay")
        print("[PASS] test_10_dynamic_schema_builder_and_presets")

    def test_11_idgen_pagination_and_filtering(self):
        self.login_admin()
        # Query page 1 with limit 1
        res = self.client.get("/api/id-generator/persons?page=1&limit=1")
        self.assertEqual(res.status_code, 200)
        data = json.loads(res.data)
        self.assertIn("persons", data)
        self.assertIn("total", data)
        self.assertIn("total_all", data)
        self.assertIn("page", data)
        self.assertIn("limit", data)
        self.assertEqual(data["page"], 1)
        self.assertEqual(data["limit"], 1)
        self.assertEqual(len(data["persons"]), 1)

        # Query with specific filter
        res2 = self.client.get("/api/id-generator/persons?page=1&limit=25&q=NORA")
        self.assertEqual(res2.status_code, 200)
        data2 = json.loads(res2.data)
        self.assertTrue(any("NORA" in p["name"].upper() for p in data2["persons"]))
        print("[PASS] test_11_idgen_pagination_and_filtering")

if __name__ == "__main__":
    unittest.main()

